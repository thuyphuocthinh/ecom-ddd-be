import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogoutAllHandler } from './logout-all.handler.js';
import { LogoutAllCommand } from './logout-all.command.js';
import type { TokenStore } from '../../infrastructure/index.js';

describe('LogoutAllHandler', () => {
  let handler: LogoutAllHandler;
  let tokenStore: { bumpTokenVersion: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tokenStore = { bumpTokenVersion: vi.fn().mockResolvedValue(undefined) };
    handler = new LogoutAllHandler(tokenStore as unknown as TokenStore);
  });

  it('calls bumpTokenVersion with the correct userId (SC-11)', async () => {
    await handler.execute(new LogoutAllCommand('user-abc'));
    expect(tokenStore.bumpTokenVersion).toHaveBeenCalledOnce();
    expect(tokenStore.bumpTokenVersion).toHaveBeenCalledWith('user-abc');
  });

  it('does not call bumpTokenVersion for a different userId', async () => {
    await handler.execute(new LogoutAllCommand('user-abc'));
    expect(tokenStore.bumpTokenVersion).not.toHaveBeenCalledWith('user-xyz');
  });
});
