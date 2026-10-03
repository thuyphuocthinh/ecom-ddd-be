import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { CredentialProvider } from '@prisma/client';
import { ResetPasswordHandler } from './reset-password.handler.js';
import { ResetPasswordCommand } from './reset-password.command.js';
import { AuthErrorCodes, type AppConfig } from '@/core/index.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import type { IPasswordRepository } from '../../domain/index.js';
import type { TokenStore } from '../../infrastructure/index.js';
import type { OtpService } from '../services/otp.service.js';
import type { PasswordMailer } from '../services/password-mailer.service.js';
import type { TokenIssuer } from '../services/token-issuer.service.js';

const CLIENT = { ip: '203.0.113.7', userAgent: 'Chrome' };
const GOOD = '7-purple-Giraffes-dance';
const reset = (newPassword = GOOD, code = '482915') =>
  new ResetPasswordCommand('jane@example.com', code, newPassword, CLIENT);
const USER = {
  id: 'user-1',
  credentials: [
    {
      id: 'cred-1',
      provider: CredentialProvider.EMAIL,
      identifier: 'jane@example.com',
      secret: '$argon2id$old',
    },
  ],
};

describe('ResetPasswordHandler', () => {
  let handler: ResetPasswordHandler;
  let calls: string[];
  let userRepo: { findByCredential: ReturnType<typeof vi.fn> };
  let passwordRepo: { changePassword: ReturnType<typeof vi.fn> };
  let otp: {
    verify: ReturnType<typeof vi.fn>;
    consume: ReturnType<typeof vi.fn>;
    releaseSend: ReturnType<typeof vi.fn>;
  };
  let tokenStore: {
    bumpTokenVersion: ReturnType<typeof vi.fn>;
    markSessionsRevoked: ReturnType<typeof vi.fn>;
  };
  let mailer: { sendPasswordChanged: ReturnType<typeof vi.fn> };
  let logged: string[];

  const expectInvalidCode = (promise: Promise<unknown>) =>
    expect(promise).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.INVALID_VERIFICATION_CODE.code,
    );

  beforeEach(() => {
    vi.restoreAllMocks();
    logged = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      logged.push(String(m));
    });
    vi.spyOn(HashUtil, 'hashPassword').mockImplementation(async () => {
      calls.push('hash');
      return '$argon2id$new';
    });
    calls = [];
    userRepo = { findByCredential: vi.fn().mockResolvedValue(USER) };
    passwordRepo = {
      changePassword: vi.fn().mockImplementation(async () => {
        calls.push('change password and close sessions');
        return { changed: true, revokedSessionIds: ['sid-1', 'sid-2'] };
      }),
    };
    otp = {
      verify: vi.fn().mockImplementation(async () => {
        calls.push('verify code');
        return true;
      }),
      consume: vi.fn().mockImplementation(async () => {
        calls.push('use code up');
        return true;
      }),
      releaseSend: vi.fn().mockResolvedValue(undefined),
    };
    tokenStore = {
      bumpTokenVersion: vi.fn().mockImplementation(async () => {
        calls.push('bump token version');
      }),
      markSessionsRevoked: vi.fn().mockImplementation(async () => {
        calls.push('flag sessions');
      }),
    };
    mailer = {
      sendPasswordChanged: vi.fn().mockImplementation(async () => {
        calls.push('send notice');
      }),
    };

    handler = new ResetPasswordHandler(
      userRepo as unknown as IUserRepository,
      passwordRepo as unknown as IPasswordRepository,
      otp as unknown as OtpService,
      tokenStore as unknown as TokenStore,
      { accessTtlSeconds: 900 } as unknown as TokenIssuer,
      mailer as unknown as PasswordMailer,
      { name: 'Ecom' } as AppConfig,
    );
  });

  it('runs the steps in the safe order (AC-3, AC-11)', async () => {
    await handler.execute(reset());

    expect(calls).toEqual([
      'verify code',
      'hash',
      'bump token version',
      'use code up',
      'change password and close sessions',
      'flag sessions',
      'send notice',
    ]);
  });

  it('replaces the password and closes every session in one repository call (AC-3)', async () => {
    await handler.execute(reset());

    expect(passwordRepo.changePassword).toHaveBeenCalledOnce();
    expect(passwordRepo.changePassword).toHaveBeenCalledWith({
      userId: 'user-1',
      credentialId: 'cred-1',
      newHash: '$argon2id$new',
      reason: 'PASSWORD_RESET',
      now: expect.any(Date),
    });
    // a reset has no "only if the old hash is still this one" condition
    expect(passwordRepo.changePassword.mock.calls[0][0]).not.toHaveProperty(
      'expectedOldHash',
    );
  });

  it('flags the sessions that were closed, and refuses every older token by bumping the version (AC-3)', async () => {
    await handler.execute(reset());

    expect(tokenStore.bumpTokenVersion).toHaveBeenCalledWith('user-1');
    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledWith(
      ['sid-1', 'sid-2'],
      900,
    );
  });

  it('checks the code with the caller IP, so one client cannot burn the real owner code (AC-4)', async () => {
    await handler.execute(reset());

    expect(otp.verify).toHaveBeenCalledWith(
      'RESET_PASSWORD',
      'jane@example.com',
      '482915',
      CLIENT.ip,
    );
  });

  it('refuses an easy password BEFORE touching the code, so no guess is used and nothing changes (AC-5)', async () => {
    await expect(handler.execute(reset('password123'))).rejects.toSatisfy(
      (e: any) =>
        e.code === AuthErrorCodes.WEAK_PASSWORD.code &&
        e.details.reason === 'COMMON',
    );

    expect(otp.verify).not.toHaveBeenCalled();
    expect(tokenStore.bumpTokenVersion).not.toHaveBeenCalled();
    expect(passwordRepo.changePassword).not.toHaveBeenCalled();
  });

  it('gives one answer for a wrong code and for an address with no account, and changes nothing (AC-4)', async () => {
    otp.verify.mockResolvedValue(false);
    await expectInvalidCode(handler.execute(reset()));

    otp.verify.mockResolvedValue(true);
    userRepo.findByCredential.mockResolvedValue(null);
    await expectInvalidCode(handler.execute(reset()));

    expect(passwordRepo.changePassword).not.toHaveBeenCalled();
    expect(tokenStore.bumpTokenVersion).not.toHaveBeenCalled();
  });

  it('treats an account without an email password like no account (AC-4)', async () => {
    userRepo.findByCredential.mockResolvedValue({
      id: 'user-2',
      credentials: [
        {
          provider: CredentialProvider.EMAIL,
          identifier: 'jane@example.com',
          secret: null,
        },
      ],
    });

    await expectInvalidCode(handler.execute(reset()));
  });

  it('loses cleanly when another request used the code first: nothing is changed (AC-13)', async () => {
    otp.consume.mockResolvedValue(false);

    await expectInvalidCode(handler.execute(reset()));

    expect(passwordRepo.changePassword).not.toHaveBeenCalled();
  });

  it('stops with the code untouched when Redis fails before the transaction (AC-11)', async () => {
    tokenStore.bumpTokenVersion.mockRejectedValue(new Error('redis down'));

    // a Redis failure answers 503, not a bare 500
    await expect(handler.execute(reset())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(otp.consume).not.toHaveBeenCalled();
    expect(passwordRepo.changePassword).not.toHaveBeenCalled();
  });

  it('gives the send slot back when the database step fails after the code was used up, so a new code can be asked for at once (AC-11)', async () => {
    passwordRepo.changePassword.mockRejectedValue(new Error('db down'));

    await expect(handler.execute(reset())).rejects.toThrow('db down');

    expect(otp.releaseSend).toHaveBeenCalledWith(
      'RESET_PASSWORD',
      'jane@example.com',
    );
    expect(mailer.sendPasswordChanged).not.toHaveBeenCalled();
  });

  it('answers the code error and gives the slot back when the credential has vanished meanwhile', async () => {
    passwordRepo.changePassword.mockResolvedValue({
      changed: false,
      revokedSessionIds: [],
    });

    await expectInvalidCode(handler.execute(reset()));
    expect(otp.releaseSend).toHaveBeenCalledOnce();
  });

  it('still succeeds, and only logs, when flagging the sessions fails after the transaction (AC-11)', async () => {
    tokenStore.markSessionsRevoked.mockRejectedValue(new Error('redis down'));

    await expect(handler.execute(reset())).resolves.toBeUndefined();

    expect(logged.join('\n')).toContain('Could not flag the sessions');
    expect(mailer.sendPasswordChanged).toHaveBeenCalledWith('jane@example.com');
  });

  it('never puts the password in a log line', async () => {
    tokenStore.markSessionsRevoked.mockRejectedValue(new Error('redis down'));

    await handler.execute(reset());

    expect(logged.join('\n')).not.toContain(GOOD);
  });
});
