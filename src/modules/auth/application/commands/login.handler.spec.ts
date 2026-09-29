import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as argon2 from 'argon2';
import { LoginHandler } from './login.handler.js';
import { LoginCommand } from './login.command.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import { AuthErrorCodes, HashUtil } from '@/core/index.js';
import { CredentialProvider } from '@prisma/client';
import type { TokenStore } from '../../infrastructure/index.js';
import type { TokenIssuer } from '../services/token-issuer.service.js';

const buildUser = (email: string, passwordHash: string | null) => ({
  id: 'user-123',
  role: 'CUSTOMER',
  credentials: [
    {
      provider: CredentialProvider.EMAIL,
      identifier: email,
      secret: passwordHash,
    },
  ],
});

describe('LoginHandler', () => {
  let handler: LoginHandler;
  let userRepo: { findByCredential: ReturnType<typeof vi.fn> };
  let tokenStore: {
    getTokenVersion: ReturnType<typeof vi.fn>;
    storeRefreshToken: ReturnType<typeof vi.fn>;
  };
  let tokenIssuer: {
    issue: ReturnType<typeof vi.fn>;
    refreshTtlSeconds: number;
  };

  beforeEach(() => {
    userRepo = { findByCredential: vi.fn() };
    tokenStore = {
      getTokenVersion: vi.fn().mockResolvedValue(7),
      storeRefreshToken: vi.fn().mockResolvedValue(undefined),
    };
    tokenIssuer = {
      issue: vi
        .fn()
        .mockReturnValue({
          accessToken: 'signed.access.token',
          refreshToken: 'opaque-rt',
        }),
      refreshTtlSeconds: 604800,
    };

    handler = new LoginHandler(
      userRepo as unknown as IUserRepository,
      tokenStore as unknown as TokenStore,
      tokenIssuer as unknown as TokenIssuer,
    );
  });

  it('throws INVALID_CREDENTIALS when user is not found — must not reveal that email does not exist', async () => {
    userRepo.findByCredential.mockResolvedValue(null);

    const err = await handler
      .execute(new LoginCommand('noone@example.com', 'anypass'))
      .catch((e) => e);

    expect(err.code).toBe(AuthErrorCodes.INVALID_CREDENTIALS.code);
    // Error message must not leak "not found" or "exist", but "invalid email or password" is fine
    expect(err.message.toLowerCase()).not.toContain('not found');
    expect(err.message.toLowerCase()).not.toContain('exist');
  });

  it('throws INVALID_CREDENTIALS when password is wrong — same error as "user not found"', async () => {
    const hash = await argon2.hash('correctpass');
    userRepo.findByCredential.mockResolvedValue(buildUser('u@e.com', hash));

    const err = await handler
      .execute(new LoginCommand('u@e.com', 'wrongpass'))
      .catch((e) => e);

    expect(err.code).toBe(AuthErrorCodes.INVALID_CREDENTIALS.code);
    expect(tokenStore.storeRefreshToken).not.toHaveBeenCalled();
  });

  it('throws INVALID_CREDENTIALS for an account with no password secret (e.g. OAuth-only)', async () => {
    userRepo.findByCredential.mockResolvedValue(buildUser('u@e.com', null));

    const err = await handler
      .execute(new LoginCommand('u@e.com', 'anypass'))
      .catch((e) => e);

    expect(err.code).toBe(AuthErrorCodes.INVALID_CREDENTIALS.code);
  });

  it('spends the same password-verification work on an unknown email as on a wrong password (no timing oracle)', async () => {
    const compare = vi.spyOn(HashUtil, 'comparePassword');
    const hash = await argon2.hash('correctpass');

    userRepo.findByCredential.mockResolvedValue(null);
    await handler
      .execute(new LoginCommand('noone@example.com', 'anypass'))
      .catch(() => undefined);
    const unknownEmailCalls = compare.mock.calls.length;
    // it must verify against a real argon2 hash, not short-circuit on a dummy string
    const dummy = compare.mock.calls[0][1];
    expect(dummy.startsWith('$argon2id$')).toBe(true);

    compare.mockClear();
    userRepo.findByCredential.mockResolvedValue(buildUser('u@e.com', hash));
    await handler
      .execute(new LoginCommand('u@e.com', 'wrongpass'))
      .catch(() => undefined);
    const wrongPasswordCalls = compare.mock.calls.length;

    expect(unknownEmailCalls).toBe(1);
    expect(wrongPasswordCalls).toBe(1);
    compare.mockRestore();
  });

  it('issues tokens for the current token version, stores the RT and returns the pair', async () => {
    const hash = await argon2.hash('correctpass');
    const user = buildUser('u@e.com', hash);
    userRepo.findByCredential.mockResolvedValue(user);

    const result = await handler.execute(
      new LoginCommand('u@e.com', 'correctpass'),
    );

    expect(result).toEqual({
      accessToken: 'signed.access.token',
      refreshToken: 'opaque-rt',
    });
    expect(tokenIssuer.issue).toHaveBeenCalledWith(user, 7);
    expect(tokenStore.storeRefreshToken).toHaveBeenCalledWith(
      'opaque-rt',
      'user-123',
      7,
      604800,
    );
  });
});
