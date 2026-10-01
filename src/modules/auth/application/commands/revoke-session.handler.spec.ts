import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RevokeSessionHandler } from './revoke-session.handler.js';
import { RevokeSessionCommand } from './revoke-session.command.js';
import type { ISessionRepository } from '../../domain/index.js';
import { AuthErrorCodes } from '@/core/index.js';
import type { TokenStore } from '../../infrastructure/index.js';
import type { TokenIssuer } from '../services/token-issuer.service.js';

describe('RevokeSessionHandler', () => {
  let handler: RevokeSessionHandler;
  let calls: string[];
  let sessionRepo: {
    findActiveByUser: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };
  let tokenStore: { markSessionsRevoked: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    calls = [];
    sessionRepo = {
      findActiveByUser: vi
        .fn()
        .mockResolvedValue([{ id: 'sid-a' }, { id: 'sid-b' }]),
      revoke: vi.fn().mockImplementation(async () => {
        calls.push('revoke in database');
        return true;
      }),
    };
    tokenStore = {
      markSessionsRevoked: vi.fn().mockImplementation(async () => {
        calls.push('flag in redis');
      }),
    };
    handler = new RevokeSessionHandler(
      sessionRepo as unknown as ISessionRepository,
      tokenStore as unknown as TokenStore,
      { accessTtlSeconds: 900 } as unknown as TokenIssuer,
    );
  });

  it("revokes the user's own session and flags it in Redis (AC-3)", async () => {
    await handler.execute(new RevokeSessionCommand('user-1', 'sid-b'));

    expect(sessionRepo.findActiveByUser).toHaveBeenCalledWith(
      'user-1',
      expect.any(Date),
    );
    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledWith(['sid-b'], 900);
    expect(sessionRepo.revoke).toHaveBeenCalledWith(
      'sid-b',
      'user-1',
      'LOGOUT',
      expect.any(Date),
    );
  });

  it('flags first, then closes in the database, so a retry after a failure redoes everything', async () => {
    await handler.execute(new RevokeSessionCommand('user-1', 'sid-b'));

    expect(calls).toEqual(['flag in redis', 'revoke in database']);
  });

  it('answers SESSION_NOT_FOUND for an id that is not among the user’s live sessions (AC-4)', async () => {
    const err = await handler
      .execute(new RevokeSessionCommand('user-x', 'sid-of-user-y'))
      .catch((e) => e);

    expect(err.code).toBe(AuthErrorCodes.SESSION_NOT_FOUND.code);
  });

  it('never writes an id the caller does not own to Redis, nor touches the database', async () => {
    await handler
      .execute(new RevokeSessionCommand('user-x', 'sid-of-user-y'))
      .catch(() => undefined);

    expect(tokenStore.markSessionsRevoked).not.toHaveBeenCalled();
    expect(sessionRepo.revoke).not.toHaveBeenCalled();
  });

  it('is still a success when a concurrent request closed the session first', async () => {
    sessionRepo.revoke.mockResolvedValue(false);

    await expect(
      handler.execute(new RevokeSessionCommand('user-1', 'sid-b')),
    ).resolves.toBeUndefined();
  });

  it('can be retried after the database step failed: the session is still live and gets flagged again', async () => {
    sessionRepo.revoke.mockRejectedValueOnce(new Error('db down'));

    await expect(
      handler.execute(new RevokeSessionCommand('user-1', 'sid-b')),
    ).rejects.toThrow('db down');
    await expect(
      handler.execute(new RevokeSessionCommand('user-1', 'sid-b')),
    ).resolves.toBeUndefined();
    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledTimes(2);
  });

  it('does not report success when Redis cannot be written, and leaves the database untouched', async () => {
    tokenStore.markSessionsRevoked.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      handler.execute(new RevokeSessionCommand('user-1', 'sid-b')),
    ).rejects.toThrow('ECONNREFUSED');
    expect(sessionRepo.revoke).not.toHaveBeenCalled();
  });
});
