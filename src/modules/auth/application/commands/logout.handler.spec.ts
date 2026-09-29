import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogoutHandler } from './logout.handler.js';
import { LogoutCommand } from './logout.command.js';
import type { TokenStore } from '../../infrastructure/index.js';

describe('LogoutHandler', () => {
  let handler: LogoutHandler;
  let tokenStore: {
    revokeRefreshToken: ReturnType<typeof vi.fn>;
    blacklistAccessToken: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    tokenStore = {
      revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
      blacklistAccessToken: vi.fn().mockResolvedValue(undefined),
    };
    handler = new LogoutHandler(tokenStore as unknown as TokenStore);
  });

  it('revokes the refresh token and blacklists the access token with correct TTL', async () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 600; // 10 minutes remaining

    await handler.execute(
      new LogoutCommand('access-token', 'refresh-token', exp),
    );

    expect(tokenStore.revokeRefreshToken).toHaveBeenCalledWith('refresh-token');
    expect(tokenStore.blacklistAccessToken).toHaveBeenCalledWith(
      'access-token',
      expect.any(Number),
    );
    const ttlUsed = tokenStore.blacklistAccessToken.mock.calls[0][1] as number;
    // TTL should be close to 600 (within 5 seconds of test execution time)
    expect(ttlUsed).toBeGreaterThan(595);
    expect(ttlUsed).toBeLessThanOrEqual(600);
  });

  it('does NOT blacklist the access token when it is already expired (TTL <= 0)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now - 60; // already expired

    await handler.execute(
      new LogoutCommand('expired-at', 'refresh-token', exp),
    );

    expect(tokenStore.revokeRefreshToken).toHaveBeenCalledWith('refresh-token');
    expect(tokenStore.blacklistAccessToken).not.toHaveBeenCalled();
  });
});
