import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogoutHandler } from './logout.handler.js';
import { LogoutCommand } from './logout.command.js';
import type { ISessionRepository } from '../../domain/index.js';
import type { TokenStore } from '../../infrastructure/index.js';
import type { TokenIssuer } from '../services/token-issuer.service.js';

describe('LogoutHandler', () => {
  let handler: LogoutHandler;
  let sessionRepo: { revoke: ReturnType<typeof vi.fn> };
  let tokenStore: { markSessionsRevoked: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sessionRepo = { revoke: vi.fn().mockResolvedValue(true) };
    tokenStore = { markSessionsRevoked: vi.fn().mockResolvedValue(undefined) };
    handler = new LogoutHandler(
      sessionRepo as unknown as ISessionRepository,
      tokenStore as unknown as TokenStore,
      { accessTtlSeconds: 900 } as unknown as TokenIssuer,
    );
  });

  it('revokes the session of the request with reason LOGOUT and flags it in Redis for one access-token lifetime', async () => {
    await handler.execute(new LogoutCommand('sid-1', 'user-1'));

    expect(sessionRepo.revoke).toHaveBeenCalledWith(
      'sid-1',
      'user-1',
      'LOGOUT',
      expect.any(Date),
    );
    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledWith(['sid-1'], 900);
  });

  it('still flags the session when it was already closed, so a retried logout ends up revoked', async () => {
    sessionRepo.revoke.mockResolvedValue(false);

    await handler.execute(new LogoutCommand('sid-1', 'user-1'));

    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledWith(['sid-1'], 900);
  });

  it('does not report success when Redis cannot be written', async () => {
    tokenStore.markSessionsRevoked.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      handler.execute(new LogoutCommand('sid-1', 'user-1')),
    ).rejects.toThrow('ECONNREFUSED');
  });
});
