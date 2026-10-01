import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RefreshTokenHandler } from './refresh-token.handler.js';
import { RefreshTokenCommand } from './refresh-token.command.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import { Session } from '../../domain/index.js';
import type { ISessionRepository } from '../../domain/index.js';
import { AuthErrorCodes, HashUtil } from '@/core/index.js';
import type { TokenStore } from '../../infrastructure/index.js';
import type { TokenIssuer } from '../services/token-issuer.service.js';

const MOCK_USER = { id: 'user-1', role: 'CUSTOMER' };
const NEW_PAIR = { accessToken: 'new.access.token', refreshToken: 'new-rt' };
const IP = '198.51.100.9';

const buildSession = (
  overrides: Partial<ConstructorParameters<typeof Session>[0]> = {},
) =>
  new Session({
    id: 'sid-1',
    userId: 'user-1',
    refreshTokenHash: HashUtil.sha256('old-rt'),
    previousRefreshTokenHash: null,
    rotatedAt: null,
    deviceName: 'Chrome',
    ipAddress: '203.0.113.7',
    lastUsedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  });

describe('RefreshTokenHandler', () => {
  let handler: RefreshTokenHandler;
  let userRepo: { findById: ReturnType<typeof vi.fn> };
  let sessionRepo: {
    findActiveByRefreshHash: ReturnType<typeof vi.fn>;
    findActiveByPreviousHash: ReturnType<typeof vi.fn>;
    rotate: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };
  let tokenStore: {
    getRotationGrace: ReturnType<typeof vi.fn>;
    setRotationGrace: ReturnType<typeof vi.fn>;
    getTokenVersion: ReturnType<typeof vi.fn>;
    markSessionsRevoked: ReturnType<typeof vi.fn>;
  };
  let tokenIssuer: {
    issue: ReturnType<typeof vi.fn>;
    refreshTtlSeconds: number;
    sessionAbsoluteTtlSeconds: number;
    accessTtlSeconds: number;
  };

  const refresh = (token = 'old-rt') =>
    handler.execute(new RefreshTokenCommand(token, IP));

  const expectUnauthorized = (promise: Promise<unknown>) =>
    expect(promise).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.UNAUTHORIZED_ACCESS.code,
    );

  beforeEach(() => {
    userRepo = { findById: vi.fn().mockResolvedValue(MOCK_USER) };
    sessionRepo = {
      findActiveByRefreshHash: vi.fn().mockResolvedValue(null),
      findActiveByPreviousHash: vi.fn().mockResolvedValue(null),
      rotate: vi.fn().mockResolvedValue(true),
      revoke: vi.fn().mockResolvedValue(true),
    };
    tokenStore = {
      getRotationGrace: vi.fn().mockResolvedValue(null),
      setRotationGrace: vi.fn().mockResolvedValue(undefined),
      getTokenVersion: vi.fn().mockResolvedValue(1),
      markSessionsRevoked: vi.fn().mockResolvedValue(undefined),
    };
    tokenIssuer = {
      issue: vi.fn().mockReturnValue(NEW_PAIR),
      refreshTtlSeconds: 604800,
      sessionAbsoluteTtlSeconds: 2592000,
      accessTtlSeconds: 900,
    };

    handler = new RefreshTokenHandler(
      userRepo as unknown as IUserRepository,
      sessionRepo as unknown as ISessionRepository,
      tokenStore as unknown as TokenStore,
      tokenIssuer as unknown as TokenIssuer,
    );
  });

  describe('grace window (AC-10)', () => {
    it('returns the already-issued pair immediately, without touching sessions', async () => {
      const cachedPair = {
        accessToken: 'cached.at',
        refreshToken: 'cached.rt',
      };
      tokenStore.getRotationGrace.mockResolvedValue(cachedPair);

      await expect(refresh()).resolves.toEqual(cachedPair);

      expect(sessionRepo.findActiveByRefreshHash).not.toHaveBeenCalled();
      expect(sessionRepo.revoke).not.toHaveBeenCalled();
    });
  });

  describe('token that matches no live session (AC-12)', () => {
    it('throws UNAUTHORIZED_ACCESS when nothing matches, current or previous', async () => {
      await expectUnauthorized(refresh('stolen-rt'));

      expect(sessionRepo.rotate).not.toHaveBeenCalled();
      expect(sessionRepo.revoke).not.toHaveBeenCalled();
    });

    it('looks the token up by its hash, never by the raw value', async () => {
      await refresh('some-rt').catch(() => undefined);

      expect(sessionRepo.findActiveByRefreshHash).toHaveBeenCalledWith(
        HashUtil.sha256('some-rt'),
        expect.any(Date),
      );
    });
  });

  describe('reuse detection (AC-9)', () => {
    it('revokes only the session whose replaced token was replayed, and flags it in Redis', async () => {
      sessionRepo.findActiveByPreviousHash.mockResolvedValue(
        buildSession({
          previousRefreshTokenHash: HashUtil.sha256('old-rt'),
          rotatedAt: new Date(Date.now() - 60_000), // rotated a minute ago: past the grace window
        }),
      );

      await expectUnauthorized(refresh());

      expect(sessionRepo.revoke).toHaveBeenCalledOnce();
      expect(sessionRepo.revoke).toHaveBeenCalledWith(
        'sid-1',
        'user-1',
        'REUSE_DETECTED',
        expect.any(Date),
      );
      expect(tokenStore.markSessionsRevoked).toHaveBeenCalledWith(
        ['sid-1'],
        900,
      );
      expect(tokenStore.setRotationGrace).not.toHaveBeenCalled();
    });

    it("does NOT revoke when the replaced token was rotated a moment ago and the winner's pair never shows up (grace entry lost)", async () => {
      sessionRepo.findActiveByPreviousHash.mockResolvedValue(
        buildSession({
          previousRefreshTokenHash: HashUtil.sha256('old-rt'),
          rotatedAt: new Date(Date.now() - 2_000), // 2s ago: inside the grace window
        }),
      );

      await expectUnauthorized(refresh());

      expect(sessionRepo.revoke).not.toHaveBeenCalled();
      expect(tokenStore.markSessionsRevoked).not.toHaveBeenCalled();
    });

    it("returns the winner's pair when it appears while the loser is looking (winner writes the entry just after its update)", async () => {
      sessionRepo.findActiveByPreviousHash.mockResolvedValue(
        buildSession({
          previousRefreshTokenHash: HashUtil.sha256('old-rt'),
          rotatedAt: new Date(Date.now() - 1_000),
        }),
      );
      const winnerPair = {
        accessToken: 'winner.at',
        refreshToken: 'winner.rt',
      };
      tokenStore.getRotationGrace
        .mockResolvedValueOnce(null) // initial grace check
        .mockResolvedValueOnce(null) // first poll: not written yet
        .mockResolvedValueOnce(winnerPair); // second poll: there

      await expect(refresh()).resolves.toEqual(winnerPair);
      expect(sessionRepo.revoke).not.toHaveBeenCalled();
    });
  });

  describe('successful rotation (AC-8)', () => {
    beforeEach(() => {
      sessionRepo.findActiveByRefreshHash.mockResolvedValue(buildSession());
    });

    it('issues the new access token for the same session id and the current token version', async () => {
      tokenStore.getTokenVersion.mockResolvedValue(3);

      await refresh();

      expect(tokenIssuer.issue).toHaveBeenCalledWith(MOCK_USER, 3, 'sid-1');
    });

    it('rotates the session: new hash in, old hash kept as previous, IP and last-used updated, sid unchanged', async () => {
      await refresh();

      expect(sessionRepo.rotate).toHaveBeenCalledOnce();
      const [session, expectedHash] = sessionRepo.rotate.mock.calls[0];
      expect(expectedHash).toBe(HashUtil.sha256('old-rt'));
      expect(session).toMatchObject({
        id: 'sid-1',
        refreshTokenHash: HashUtil.sha256('new-rt'),
        previousRefreshTokenHash: HashUtil.sha256('old-rt'),
        ipAddress: IP,
      });
      expect(session.lastUsedAt.getTime()).toBeGreaterThan(
        new Date('2026-01-01T00:00:00Z').getTime(),
      );
    });

    it('still returns the new pair when the grace entry cannot be written (the rotation is already committed)', async () => {
      tokenStore.setRotationGrace.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(refresh()).resolves.toEqual(NEW_PAIR);
      expect(sessionRepo.revoke).not.toHaveBeenCalled();
    });

    it('does not extend a session past its absolute lifetime', async () => {
      const day = 86_400_000;
      const createdAt = new Date(Date.now() - 29 * day);
      sessionRepo.findActiveByRefreshHash.mockResolvedValue(
        buildSession({
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 30 * day),
        }),
      );

      await refresh();

      const [session] = sessionRepo.rotate.mock.calls[0];
      // one day left of the 30, not another 7
      expect(session.expiresAt.getTime()).toBe(createdAt.getTime() + 30 * day);
    });

    it('records the grace entry under the old token and returns the new pair', async () => {
      await expect(refresh()).resolves.toEqual(NEW_PAIR);

      expect(tokenStore.setRotationGrace).toHaveBeenCalledWith(
        'old-rt',
        NEW_PAIR,
      );
    });

    it("throws UNAUTHORIZED_ACCESS when the session's user no longer exists", async () => {
      userRepo.findById.mockResolvedValue(null);

      await expectUnauthorized(refresh());
      expect(sessionRepo.rotate).not.toHaveBeenCalled();
    });
  });

  describe('concurrent refresh (AC-11)', () => {
    beforeEach(() => {
      sessionRepo.findActiveByRefreshHash.mockResolvedValue(buildSession());
      sessionRepo.rotate.mockResolvedValue(false); // another request rotated first
    });

    it("returns the winner's pair, not its own (which was never stored)", async () => {
      const winnerPair = {
        accessToken: 'winner.at',
        refreshToken: 'winner.rt',
      };
      tokenStore.getRotationGrace
        .mockResolvedValueOnce(null) // initial check
        .mockResolvedValueOnce(winnerPair); // after losing

      await expect(refresh()).resolves.toEqual(winnerPair);
      expect(tokenStore.setRotationGrace).not.toHaveBeenCalled();
    });

    it("polls briefly for the winner's entry before giving up", async () => {
      const winnerPair = {
        accessToken: 'winner.at',
        refreshToken: 'winner.rt',
      };
      tokenStore.getRotationGrace
        .mockResolvedValueOnce(null) // initial check
        .mockResolvedValueOnce(null) // poll 1
        .mockResolvedValueOnce(null) // poll 2
        .mockResolvedValueOnce(winnerPair); // poll 3

      await expect(refresh()).resolves.toEqual(winnerPair);
    });

    it("throws UNAUTHORIZED_ACCESS when the winner's entry never appears", async () => {
      await expectUnauthorized(refresh());

      // 1 initial check + 10 polls
      expect(tokenStore.getRotationGrace).toHaveBeenCalledTimes(11);
    });
  });

  describe('infrastructure failures (AC-13): never hand out tokens that were not stored', () => {
    it('rejects, and returns no token, when the session update fails', async () => {
      sessionRepo.findActiveByRefreshHash.mockResolvedValue(buildSession());
      sessionRepo.rotate.mockRejectedValue(new Error('db down'));

      await expect(refresh()).rejects.toThrow('db down');
      expect(tokenStore.setRotationGrace).not.toHaveBeenCalled();
    });

    it('rejects when the session lookup fails', async () => {
      sessionRepo.findActiveByRefreshHash.mockRejectedValue(
        new Error('db down'),
      );

      await expect(refresh()).rejects.toThrow('db down');
    });
  });
});
