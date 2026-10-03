import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RevokeOtherSessionsHandler } from './revoke-other-sessions.handler.js';
import { RevokeOtherSessionsCommand } from './revoke-other-sessions.command.js';
import type { ISessionRepository } from '../../domain/index.js';
import type { TokenStore } from '../../infrastructure/index.js';
import type { TokenIssuer } from '../services/token-issuer.service.js';

describe('RevokeOtherSessionsHandler', () => {
  let handler: RevokeOtherSessionsHandler;
  let calls: string[];
  let sessionRepo: {
    findActiveByUser: ReturnType<typeof vi.fn>;
    revokeAllForUser: ReturnType<typeof vi.fn>;
  };
  let tokenStore: { markSessionsRevoked: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    calls = [];
    sessionRepo = {
      findActiveByUser: vi
        .fn()
        .mockResolvedValue([{ id: 'sid-a' }, { id: 'sid-b' }, { id: 'sid-c' }]),
      revokeAllForUser: vi.fn().mockImplementation(async () => {
        calls.push('revoke in database');
        return ['sid-b', 'sid-c'];
      }),
    };
    tokenStore = {
      markSessionsRevoked: vi.fn().mockImplementation(async () => {
        calls.push('flag in redis');
      }),
    };
    handler = new RevokeOtherSessionsHandler(
      sessionRepo as unknown as ISessionRepository,
      tokenStore as unknown as TokenStore,
      { accessTtlSeconds: 900 } as unknown as TokenIssuer,
    );
  });

  it('revokes every session of the user except the current one (AC-6)', async () => {
    await handler.execute(new RevokeOtherSessionsCommand('user-1', 'sid-a'));

    expect(sessionRepo.revokeAllForUser).toHaveBeenCalledWith(
      'user-1',
      'LOGOUT_OTHERS',
      expect.any(Date),
      'sid-a',
    );
  });

  it('flags the other sessions in Redis, never the current one', async () => {
    await handler.execute(new RevokeOtherSessionsCommand('user-1', 'sid-a'));

    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledWith(
      ['sid-b', 'sid-c'],
      900,
    );
  });

  it('flags first, then closes in the database, so a retry after a failure redoes everything', async () => {
    await handler.execute(new RevokeOtherSessionsCommand('user-1', 'sid-a'));

    expect(calls).toEqual(['flag in redis', 'revoke in database']);
  });

  it('can be retried after the database step failed: the sessions are still live and get flagged again', async () => {
    sessionRepo.revokeAllForUser.mockRejectedValueOnce(new Error('db down'));

    await expect(
      handler.execute(new RevokeOtherSessionsCommand('user-1', 'sid-a')),
    ).rejects.toThrow('db down');
    await handler.execute(new RevokeOtherSessionsCommand('user-1', 'sid-a'));

    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledTimes(2);
  });

  it('does not report success when Redis cannot be written, and leaves the database untouched', async () => {
    tokenStore.markSessionsRevoked.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      handler.execute(new RevokeOtherSessionsCommand('user-1', 'sid-a')),
    ).rejects.toThrow('ECONNREFUSED');
    expect(sessionRepo.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('also flags a session that was started between listing and closing, and was closed with the others (AC-16)', async () => {
    sessionRepo.revokeAllForUser.mockResolvedValue([
      'sid-b',
      'sid-c',
      'sid-new',
    ]);

    await handler.execute(new RevokeOtherSessionsCommand('user-1', 'sid-a'));

    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledTimes(2);
    expect(tokenStore.markSessionsRevoked).toHaveBeenLastCalledWith(
      ['sid-new'],
      900,
    );
  });

  it('flags only once when nothing new appeared', async () => {
    await handler.execute(new RevokeOtherSessionsCommand('user-1', 'sid-a'));

    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledTimes(1);
  });

  it('succeeds when the current session is the only one', async () => {
    sessionRepo.findActiveByUser.mockResolvedValue([{ id: 'sid-a' }]);
    sessionRepo.revokeAllForUser.mockResolvedValue([]);

    await expect(
      handler.execute(new RevokeOtherSessionsCommand('user-1', 'sid-a')),
    ).resolves.toBeUndefined();
  });
});
