import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as argon2 from 'argon2';
import { LoginHandler } from './login.handler.js';
import { LoginCommand } from './login.command.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import { AuthErrorCodes, HashUtil } from '@/core/index.js';
import { CredentialProvider } from '@prisma/client';
import type { SessionIssuer } from '../services/session-issuer.service.js';

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

const CLIENT = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 Chrome/128.0' };
const TOKENS = {
  accessToken: 'signed.access.token',
  refreshToken: 'opaque-rt',
};
const login = (email: string, password: string, client = CLIENT) =>
  new LoginCommand(email, password, client);

describe('LoginHandler', () => {
  let handler: LoginHandler;
  let userRepo: { findByCredential: ReturnType<typeof vi.fn> };
  let sessionIssuer: { start: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    userRepo = { findByCredential: vi.fn() };
    sessionIssuer = { start: vi.fn().mockResolvedValue(TOKENS) };

    handler = new LoginHandler(
      userRepo as unknown as IUserRepository,
      sessionIssuer as unknown as SessionIssuer,
    );
  });

  it('throws INVALID_CREDENTIALS when user is not found — must not reveal that email does not exist', async () => {
    userRepo.findByCredential.mockResolvedValue(null);

    const err = await handler
      .execute(login('noone@example.com', 'anypass'))
      .catch((e) => e);

    expect(err.code).toBe(AuthErrorCodes.INVALID_CREDENTIALS.code);
    // Error message must not leak "not found" or "exist", but "invalid email or password" is fine
    expect(err.message.toLowerCase()).not.toContain('not found');
    expect(err.message.toLowerCase()).not.toContain('exist');
  });

  it('throws INVALID_CREDENTIALS when password is wrong — same error as "user not found", no session created', async () => {
    const hash = await argon2.hash('correctpass');
    userRepo.findByCredential.mockResolvedValue(buildUser('u@e.com', hash));

    const err = await handler
      .execute(login('u@e.com', 'wrongpass'))
      .catch((e) => e);

    expect(err.code).toBe(AuthErrorCodes.INVALID_CREDENTIALS.code);
    expect(sessionIssuer.start).not.toHaveBeenCalled();
  });

  it('throws INVALID_CREDENTIALS for an account with no password secret (e.g. OAuth-only)', async () => {
    userRepo.findByCredential.mockResolvedValue(buildUser('u@e.com', null));

    const err = await handler
      .execute(login('u@e.com', 'anypass'))
      .catch((e) => e);

    expect(err.code).toBe(AuthErrorCodes.INVALID_CREDENTIALS.code);
    expect(sessionIssuer.start).not.toHaveBeenCalled();
  });

  it('spends the same password-verification work on an unknown email as on a wrong password (no timing oracle)', async () => {
    const compare = vi.spyOn(HashUtil, 'comparePassword');
    const hash = await argon2.hash('correctpass');

    userRepo.findByCredential.mockResolvedValue(null);
    await handler
      .execute(login('noone@example.com', 'anypass'))
      .catch(() => undefined);
    const unknownEmailCalls = compare.mock.calls.length;
    // it must verify against a real argon2 hash, not short-circuit on a dummy string
    const dummy = compare.mock.calls[0][1];
    expect(dummy.startsWith('$argon2id$')).toBe(true);

    compare.mockClear();
    userRepo.findByCredential.mockResolvedValue(buildUser('u@e.com', hash));
    await handler.execute(login('u@e.com', 'wrongpass')).catch(() => undefined);
    const wrongPasswordCalls = compare.mock.calls.length;

    expect(unknownEmailCalls).toBe(1);
    expect(wrongPasswordCalls).toBe(1);
    compare.mockRestore();
  });

  describe('successful login', () => {
    let user: ReturnType<typeof buildUser>;

    beforeEach(async () => {
      user = buildUser('u@e.com', await argon2.hash('correctpass'));
      userRepo.findByCredential.mockResolvedValue(user);
    });

    it('starts a session for the user and returns its tokens', async () => {
      const result = await handler.execute(login('u@e.com', 'correctpass'));

      expect(result).toEqual(TOKENS);
      expect(sessionIssuer.start).toHaveBeenCalledWith(user, CLIENT);
    });

    it('does not hand out tokens when the session cannot be started', async () => {
      sessionIssuer.start.mockRejectedValue(new Error('db down'));

      await expect(
        handler.execute(login('u@e.com', 'correctpass')),
      ).rejects.toThrow('db down');
    });
  });
});
