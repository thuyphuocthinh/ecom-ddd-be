import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as argon2 from 'argon2';
import { LoginHandler } from './login.handler.js';
import { LoginCommand } from './login.command.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import type { ISessionRepository } from '../../domain/index.js';
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

const CLIENT = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 Chrome/128.0' };
const login = (email: string, password: string, client = CLIENT) =>
  new LoginCommand(email, password, client);

describe('LoginHandler', () => {
  let handler: LoginHandler;
  let userRepo: { findByCredential: ReturnType<typeof vi.fn> };
  let sessionRepo: { save: ReturnType<typeof vi.fn> };
  let tokenStore: { getTokenVersion: ReturnType<typeof vi.fn> };
  let tokenIssuer: {
    issue: ReturnType<typeof vi.fn>;
    refreshTtlSeconds: number;
    sessionAbsoluteTtlSeconds: number;
  };

  beforeEach(() => {
    userRepo = { findByCredential: vi.fn() };
    sessionRepo = { save: vi.fn().mockResolvedValue(undefined) };
    tokenStore = { getTokenVersion: vi.fn().mockResolvedValue(7) };
    tokenIssuer = {
      issue: vi.fn().mockReturnValue({
        accessToken: 'signed.access.token',
        refreshToken: 'opaque-rt',
      }),
      refreshTtlSeconds: 604800,
      sessionAbsoluteTtlSeconds: 2592000,
    };

    handler = new LoginHandler(
      userRepo as unknown as IUserRepository,
      sessionRepo as unknown as ISessionRepository,
      tokenStore as unknown as TokenStore,
      tokenIssuer as unknown as TokenIssuer,
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
    expect(sessionRepo.save).not.toHaveBeenCalled();
  });

  it('throws INVALID_CREDENTIALS for an account with no password secret (e.g. OAuth-only)', async () => {
    userRepo.findByCredential.mockResolvedValue(buildUser('u@e.com', null));

    const err = await handler
      .execute(login('u@e.com', 'anypass'))
      .catch((e) => e);

    expect(err.code).toBe(AuthErrorCodes.INVALID_CREDENTIALS.code);
    expect(sessionRepo.save).not.toHaveBeenCalled();
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

    it('returns the issued token pair', async () => {
      const result = await handler.execute(login('u@e.com', 'correctpass'));

      expect(result).toEqual({
        accessToken: 'signed.access.token',
        refreshToken: 'opaque-rt',
      });
    });

    it('issues the access token for the current token version and the new session id', async () => {
      await handler.execute(login('u@e.com', 'correctpass'));

      expect(tokenIssuer.issue).toHaveBeenCalledWith(
        user,
        7,
        expect.stringMatching(/^[0-9a-f-]{36}$/),
      );
    });

    it('stores a session carrying the device, IP and only the hash of the refresh token', async () => {
      await handler.execute(login('u@e.com', 'correctpass'));

      const sessionId = tokenIssuer.issue.mock.calls[0][2];
      expect(sessionRepo.save).toHaveBeenCalledOnce();
      const session = sessionRepo.save.mock.calls[0][0];
      expect(session).toMatchObject({
        id: sessionId, // the sid inside the access token is this session
        userId: 'user-123',
        refreshTokenHash: HashUtil.sha256('opaque-rt'),
        deviceName: CLIENT.userAgent,
        ipAddress: CLIENT.ip,
        revokedAt: null,
      });
      expect(JSON.stringify(session)).not.toContain('opaque-rt');
    });

    it('starts the session with the configured sliding and absolute lifetimes', async () => {
      await handler.execute(login('u@e.com', 'correctpass'));

      const session = sessionRepo.save.mock.calls[0][0];
      expect(
        (session.expiresAt.getTime() - session.createdAt.getTime()) / 1000,
      ).toBe(604800);

      // a shorter absolute lifetime wins over the sliding one
      sessionRepo.save.mockClear();
      tokenIssuer.sessionAbsoluteTtlSeconds = 3600;
      await handler.execute(login('u@e.com', 'correctpass'));
      const capped = sessionRepo.save.mock.calls[0][0];
      expect(
        (capped.expiresAt.getTime() - capped.createdAt.getTime()) / 1000,
      ).toBe(3600);
    });

    it('does not fail on a client with no User-Agent', async () => {
      await handler.execute(
        login('u@e.com', 'correctpass', { ip: '203.0.113.7', userAgent: '' }),
      );

      expect(sessionRepo.save.mock.calls[0][0].deviceName).toBe(
        'Unknown device',
      );
    });

    it('does not hand out tokens when the session cannot be stored', async () => {
      sessionRepo.save.mockRejectedValue(new Error('db down'));

      await expect(
        handler.execute(login('u@e.com', 'correctpass')),
      ).rejects.toThrow('db down');
    });
  });
});
