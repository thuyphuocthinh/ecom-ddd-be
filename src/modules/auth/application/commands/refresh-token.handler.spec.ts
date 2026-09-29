import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RefreshTokenHandler } from './refresh-token.handler.js';
import { RefreshTokenCommand } from './refresh-token.command.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import { AuthErrorCodes } from '@/core/index.js';
import type { TokenStore } from '../../infrastructure/index.js';
import type { TokenIssuer } from '../services/token-issuer.service.js';

const MOCK_USER = { id: 'user-1', role: 'CUSTOMER' };
const NEW_PAIR = { accessToken: 'new.access.token', refreshToken: 'new-rt' };

describe('RefreshTokenHandler', () => {
  let handler: RefreshTokenHandler;
  let userRepo: { findById: ReturnType<typeof vi.fn> };
  let tokenStore: {
    getRotationGrace: ReturnType<typeof vi.fn>;
    verifyRefreshToken: ReturnType<typeof vi.fn>;
    getTokenVersion: ReturnType<typeof vi.fn>;
    revokeRefreshToken: ReturnType<typeof vi.fn>;
    rotateRefreshToken: ReturnType<typeof vi.fn>;
  };
  let tokenIssuer: {
    issue: ReturnType<typeof vi.fn>;
    refreshTtlSeconds: number;
  };

  const expectUnauthorized = (promise: Promise<unknown>) =>
    expect(promise).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.UNAUTHORIZED_ACCESS.code,
    );

  beforeEach(() => {
    userRepo = { findById: vi.fn().mockResolvedValue(MOCK_USER) };
    tokenStore = {
      getRotationGrace: vi.fn().mockResolvedValue(null),
      verifyRefreshToken: vi.fn(),
      getTokenVersion: vi.fn().mockResolvedValue(1),
      revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
      rotateRefreshToken: vi.fn().mockResolvedValue(true),
    };
    tokenIssuer = {
      issue: vi.fn().mockReturnValue(NEW_PAIR),
      refreshTtlSeconds: 604800,
    };

    handler = new RefreshTokenHandler(
      userRepo as unknown as IUserRepository,
      tokenStore as unknown as TokenStore,
      tokenIssuer as unknown as TokenIssuer,
    );
  });

  it('returns grace window tokens immediately on concurrent refresh (SC-9)', async () => {
    const cachedPair = { accessToken: 'cached.at', refreshToken: 'cached.rt' };
    tokenStore.getRotationGrace.mockResolvedValue(cachedPair);

    const result = await handler.execute(new RefreshTokenCommand('old-rt'));

    expect(result).toEqual(cachedPair);
    // Must NOT call verifyRefreshToken — returns early
    expect(tokenStore.verifyRefreshToken).not.toHaveBeenCalled();
  });

  it('throws UNAUTHORIZED_ACCESS when RT is unknown and there is no grace window (SC-8)', async () => {
    tokenStore.verifyRefreshToken.mockResolvedValue(null);

    await expectUnauthorized(
      handler.execute(new RefreshTokenCommand('stolen-rt')),
    );
    expect(tokenStore.rotateRefreshToken).not.toHaveBeenCalled();
  });

  it('rotates RT atomically and returns the new token pair (SC-7)', async () => {
    tokenStore.verifyRefreshToken.mockResolvedValue({
      userId: 'user-1',
      version: 1,
    });

    const result = await handler.execute(new RefreshTokenCommand('valid-rt'));

    expect(result).toEqual(NEW_PAIR);
    expect(tokenIssuer.issue).toHaveBeenCalledWith(MOCK_USER, 1);
    expect(tokenStore.rotateRefreshToken).toHaveBeenCalledWith({
      oldRefreshToken: 'valid-rt',
      newRefreshToken: 'new-rt',
      userId: 'user-1',
      version: 1,
      ttl: 604800,
      newTokens: NEW_PAIR,
    });
  });

  describe('concurrent refresh with the same RT (SEC-W05)', () => {
    beforeEach(() => {
      tokenStore.verifyRefreshToken.mockResolvedValue({
        userId: 'user-1',
        version: 1,
      });
    });

    it("loses the rotation race → returns the WINNER's pair, not its own unstored one", async () => {
      const winnerPair = {
        accessToken: 'winner.at',
        refreshToken: 'winner-rt',
      };
      tokenStore.rotateRefreshToken.mockResolvedValue(false);
      tokenStore.getRotationGrace
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winnerPair);

      const result = await handler.execute(
        new RefreshTokenCommand('contested-rt'),
      );

      expect(result).toEqual(winnerPair);
      expect(result).not.toEqual(NEW_PAIR);
    });

    it('loses the race and finds no winner entry → 401 rather than an unstored token', async () => {
      tokenStore.rotateRefreshToken.mockResolvedValue(false);

      await expectUnauthorized(
        handler.execute(new RefreshTokenCommand('contested-rt')),
      );
    });

    it('two simultaneous calls end up with one identical pair (a real store would let exactly one rotate)', async () => {
      let claimed = false;
      let graceEntry: typeof NEW_PAIR | null = null;
      tokenStore.getRotationGrace.mockImplementation(async () => graceEntry);
      tokenStore.rotateRefreshToken.mockImplementation(
        async (p: { newTokens: typeof NEW_PAIR }) => {
          if (claimed) return false;
          claimed = true;
          graceEntry = p.newTokens;
          return true;
        },
      );
      let n = 0;
      tokenIssuer.issue.mockImplementation(() => ({
        accessToken: `at-${++n}`,
        refreshToken: `rt-${n}`,
      }));

      const [a, b] = await Promise.all([
        handler.execute(new RefreshTokenCommand('shared-rt')),
        handler.execute(new RefreshTokenCommand('shared-rt')),
      ]);

      expect(a).toEqual(b);
    });
  });

  it('throws UNAUTHORIZED_ACCESS when RT version is behind current version (logout-all)', async () => {
    tokenStore.verifyRefreshToken.mockResolvedValue({
      userId: 'user-1',
      version: 0,
    });
    tokenStore.getTokenVersion.mockResolvedValue(3); // version bumped by logout-all

    await expectUnauthorized(
      handler.execute(new RefreshTokenCommand('old-version-rt')),
    );
    expect(tokenStore.revokeRefreshToken).toHaveBeenCalledOnce(); // cleanup
    expect(tokenStore.rotateRefreshToken).not.toHaveBeenCalled();
  });

  it('throws UNAUTHORIZED_ACCESS when user no longer exists', async () => {
    tokenStore.verifyRefreshToken.mockResolvedValue({
      userId: 'deleted-user',
      version: 1,
    });
    userRepo.findById.mockResolvedValue(null);

    await expectUnauthorized(
      handler.execute(new RefreshTokenCommand('orphan-rt')),
    );
    expect(tokenStore.revokeRefreshToken).toHaveBeenCalledOnce(); // cleanup orphan RT
  });
});
