import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogoutAllHandler } from './logout-all.handler.js';
import { LogoutAllCommand } from './logout-all.command.js';
import type { ISessionRepository } from '../../domain/index.js';
import type { TokenStore } from '../../infrastructure/index.js';
import type { TokenIssuer } from '../services/token-issuer.service.js';

describe('LogoutAllHandler', () => {
  let handler: LogoutAllHandler;
  let calls: string[];
  let sessionRepo: { revokeAllForUser: ReturnType<typeof vi.fn> };
  let tokenStore: {
    bumpTokenVersion: ReturnType<typeof vi.fn>;
    markSessionsRevoked: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    calls = [];
    sessionRepo = {
      revokeAllForUser: vi.fn().mockImplementation(async () => {
        calls.push('revoke sessions');
        return ['sid-1', 'sid-2'];
      }),
    };
    tokenStore = {
      bumpTokenVersion: vi.fn().mockImplementation(async () => {
        calls.push('bump version');
      }),
      markSessionsRevoked: vi.fn().mockImplementation(async () => {
        calls.push('flag sessions');
      }),
    };
    handler = new LogoutAllHandler(
      sessionRepo as unknown as ISessionRepository,
      tokenStore as unknown as TokenStore,
      { accessTtlSeconds: 900 } as unknown as TokenIssuer,
    );
  });

  it('revokes every session of the user with reason LOGOUT_ALL', async () => {
    await handler.execute(new LogoutAllCommand('user-abc'));

    expect(sessionRepo.revokeAllForUser).toHaveBeenCalledWith(
      'user-abc',
      'LOGOUT_ALL',
      expect.any(Date),
    );
  });

  it('bumps the token version of that user only', async () => {
    await handler.execute(new LogoutAllCommand('user-abc'));

    expect(tokenStore.bumpTokenVersion).toHaveBeenCalledOnce();
    expect(tokenStore.bumpTokenVersion).toHaveBeenCalledWith('user-abc');
  });

  it('flags the revoked sessions in Redis for one access-token lifetime', async () => {
    await handler.execute(new LogoutAllCommand('user-abc'));

    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledWith(
      ['sid-1', 'sid-2'],
      900,
    );
  });

  it('closes the sessions in the database before touching Redis, so refresh tokens die first', async () => {
    await handler.execute(new LogoutAllCommand('user-abc'));

    expect(calls[0]).toBe('revoke sessions');
  });

  it('does not report success when Redis fails after the database was updated (a retry finishes the job)', async () => {
    tokenStore.bumpTokenVersion.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      handler.execute(new LogoutAllCommand('user-abc')),
    ).rejects.toThrow('ECONNREFUSED');
    expect(sessionRepo.revokeAllForUser).toHaveBeenCalled();
  });
});
