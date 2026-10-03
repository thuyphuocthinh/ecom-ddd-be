import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { CredentialProvider } from '@prisma/client';
import { ChangePasswordHandler } from './change-password.handler.js';
import { ChangePasswordCommand } from './change-password.command.js';
import { AuthErrorCodes, type AppConfig } from '@/core/index.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import type {
  IPasswordRepository,
  ISessionRepository,
} from '../../domain/index.js';
import type { TokenStore } from '../../infrastructure/index.js';
import type { OtpService } from '../services/otp.service.js';
import type { PasswordMailer } from '../services/password-mailer.service.js';
import type { TokenIssuer } from '../services/token-issuer.service.js';

const CURRENT = 'Current-Giraffe-42!';
const NEW = '7-purple-Giraffes-dance';
const change = (current = CURRENT, next = NEW) =>
  new ChangePasswordCommand('user-1', 'sid-a', current, next);

describe('ChangePasswordHandler', () => {
  let handler: ChangePasswordHandler;
  let calls: string[];
  let userRepo: { findById: ReturnType<typeof vi.fn> };
  let passwordRepo: { changePassword: ReturnType<typeof vi.fn> };
  let sessionRepo: { findActiveByUser: ReturnType<typeof vi.fn> };
  let otp: { consume: ReturnType<typeof vi.fn> };
  let tokenStore: {
    markSessionsRevoked: ReturnType<typeof vi.fn>;
    clearSessionsRevoked: ReturnType<typeof vi.fn>;
  };
  let mailer: { sendPasswordChanged: ReturnType<typeof vi.fn> };
  let logged: string[];

  const credential = (secret: string | null = '$argon2id$old') => ({
    id: 'cred-1',
    provider: CredentialProvider.EMAIL,
    identifier: 'jane@example.com',
    secret,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    logged = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      logged.push(String(m));
    });
    calls = [];
    vi.spyOn(HashUtil, 'comparePassword').mockImplementation(
      async (plain: string) => plain === CURRENT,
    );
    vi.spyOn(HashUtil, 'hashPassword').mockImplementation(async () => {
      calls.push('hash');
      return '$argon2id$new';
    });
    userRepo = {
      findById: vi
        .fn()
        .mockResolvedValue({ id: 'user-1', credentials: [credential()] }),
    };
    sessionRepo = {
      findActiveByUser: vi
        .fn()
        .mockResolvedValue([{ id: 'sid-a' }, { id: 'sid-b' }, { id: 'sid-c' }]),
    };
    passwordRepo = {
      changePassword: vi.fn().mockImplementation(async () => {
        calls.push('change password and close sessions');
        return { changed: true, revokedSessionIds: ['sid-b', 'sid-c'] };
      }),
    };
    otp = {
      consume: vi.fn().mockImplementation(async () => {
        calls.push('cancel reset code');
        return true;
      }),
    };
    tokenStore = {
      markSessionsRevoked: vi.fn().mockImplementation(async () => {
        calls.push('flag sessions');
      }),
      clearSessionsRevoked: vi.fn().mockImplementation(async () => {
        calls.push('take flags off');
      }),
    };
    mailer = {
      sendPasswordChanged: vi.fn().mockImplementation(async () => {
        calls.push('send notice');
      }),
    };

    handler = new ChangePasswordHandler(
      userRepo as unknown as IUserRepository,
      passwordRepo as unknown as IPasswordRepository,
      sessionRepo as unknown as ISessionRepository,
      otp as unknown as OtpService,
      tokenStore as unknown as TokenStore,
      { accessTtlSeconds: 900 } as unknown as TokenIssuer,
      mailer as unknown as PasswordMailer,
      { name: 'Ecom' } as AppConfig,
    );
  });

  it('flags the other sessions first, then changes the password and closes them in one step (AC-7, AC-11)', async () => {
    await handler.execute(change());

    expect(calls).toEqual([
      'hash',
      'flag sessions',
      'change password and close sessions',
      'flag sessions',
      'cancel reset code',
      'send notice',
    ]);
    expect(tokenStore.markSessionsRevoked.mock.calls[0]).toEqual([
      ['sid-b', 'sid-c'],
      900,
    ]);
  });

  it('keeps the session the change is made from: it is excluded from the flagging and from the closing (AC-7)', async () => {
    await handler.execute(change());

    expect(passwordRepo.changePassword).toHaveBeenCalledWith({
      userId: 'user-1',
      credentialId: 'cred-1',
      newHash: '$argon2id$new',
      expectedOldHash: '$argon2id$old',
      reason: 'PASSWORD_CHANGED',
      exceptSessionId: 'sid-a',
      now: expect.any(Date),
    });
    expect(tokenStore.markSessionsRevoked.mock.calls[0][0]).not.toContain(
      'sid-a',
    );
  });

  it('only replaces the password if the stored one is still the one that was checked (AC-15)', async () => {
    await handler.execute(change());

    expect(passwordRepo.changePassword.mock.calls[0][0].expectedOldHash).toBe(
      '$argon2id$old',
    );
  });

  it('answers 409 and does not report success when somebody else changed the password meanwhile (AC-15)', async () => {
    passwordRepo.changePassword.mockResolvedValue({
      changed: false,
      revokedSessionIds: [],
    });

    await expect(handler.execute(change())).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.PASSWORD_CHANGED_CONCURRENTLY.code,
    );
    expect(mailer.sendPasswordChanged).not.toHaveBeenCalled();
    expect(otp.consume).not.toHaveBeenCalled();
  });

  it('takes the flags off the other sessions when the change did not happen, so they keep working (409)', async () => {
    passwordRepo.changePassword.mockResolvedValue({
      changed: false,
      revokedSessionIds: [],
    });

    await expect(handler.execute(change())).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.PASSWORD_CHANGED_CONCURRENTLY.code,
    );

    expect(tokenStore.clearSessionsRevoked).toHaveBeenCalledWith([
      'sid-b',
      'sid-c',
    ]);
  });

  it('takes the flags off only from sessions that are still open, not from one closed by something else meanwhile', async () => {
    passwordRepo.changePassword.mockResolvedValue({
      changed: false,
      revokedSessionIds: [],
    });
    // sid-c was closed (for instance logged out) while the change was running
    sessionRepo.findActiveByUser
      .mockResolvedValueOnce([
        { id: 'sid-a' },
        { id: 'sid-b' },
        { id: 'sid-c' },
      ])
      .mockResolvedValueOnce([{ id: 'sid-a' }, { id: 'sid-b' }]);

    await expect(handler.execute(change())).rejects.toBeDefined();

    expect(tokenStore.clearSessionsRevoked).toHaveBeenCalledWith(['sid-b']);
  });

  it('flags every session closed in the transaction again, including one that was not in the list taken earlier, because the first flags may have expired (AC-16)', async () => {
    passwordRepo.changePassword.mockResolvedValue({
      changed: true,
      revokedSessionIds: ['sid-b', 'sid-c', 'sid-new'],
    });

    await handler.execute(change());

    expect(tokenStore.markSessionsRevoked.mock.calls[1]).toEqual([
      ['sid-b', 'sid-c', 'sid-new'],
      900,
    ]);
  });

  it('refuses a wrong current password and changes nothing, not even the flags (AC-8)', async () => {
    await expect(handler.execute(change('Wrong-Giraffe-1!'))).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.INCORRECT_CURRENT_PASSWORD.code,
    );

    expect(tokenStore.markSessionsRevoked).not.toHaveBeenCalled();
    expect(passwordRepo.changePassword).not.toHaveBeenCalled();
  });

  it('refuses when the account has no password to change (AC-8)', async () => {
    userRepo.findById.mockResolvedValue({
      id: 'user-1',
      credentials: [credential(null)],
    });

    await expect(handler.execute(change())).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.INCORRECT_CURRENT_PASSWORD.code,
    );
  });

  it('refuses a new password equal to the current one, without hashing anything again (AC-9)', async () => {
    await expect(handler.execute(change(CURRENT, CURRENT))).rejects.toSatisfy(
      (e: any) =>
        e.code === AuthErrorCodes.WEAK_PASSWORD.code &&
        e.details.reason === 'SAME_AS_CURRENT',
    );

    expect(HashUtil.hashPassword).not.toHaveBeenCalled();
    expect(HashUtil.comparePassword).toHaveBeenCalledOnce();
    expect(passwordRepo.changePassword).not.toHaveBeenCalled();
  });

  it('refuses an easy new password with the reason, judged against the account email (AC-9)', async () => {
    await expect(
      handler.execute(change(CURRENT, 'xx-jane-xx-9Z')),
    ).rejects.toSatisfy(
      (e: any) =>
        e.code === AuthErrorCodes.WEAK_PASSWORD.code &&
        e.details.reason === 'CONTAINS_EMAIL',
    );
  });

  it('changes nothing and flags nothing when Redis fails before the transaction (AC-11)', async () => {
    tokenStore.markSessionsRevoked.mockRejectedValue(new Error('redis down'));

    await expect(handler.execute(change())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(passwordRepo.changePassword).not.toHaveBeenCalled();
  });

  it('fails without a notice when the database step fails (AC-11)', async () => {
    passwordRepo.changePassword.mockRejectedValue(new Error('db down'));

    await expect(handler.execute(change())).rejects.toThrow('db down');

    expect(mailer.sendPasswordChanged).not.toHaveBeenCalled();
    // the other sessions were flagged first and are still open: the flags come off again
    expect(tokenStore.clearSessionsRevoked).toHaveBeenCalledOnce();
  });

  it('still succeeds, and only logs, when what follows the transaction fails (AC-11)', async () => {
    tokenStore.markSessionsRevoked
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis down'));
    otp.consume.mockRejectedValue(new Error('redis down'));

    await expect(handler.execute(change())).resolves.toBeUndefined();

    expect(logged.join('\n')).toContain('Could not flag sessions');
    expect(logged.join('\n')).toContain('Could not cancel the reset code');
    expect(mailer.sendPasswordChanged).toHaveBeenCalledWith('jane@example.com');
  });

  it('cancels a reset code that is still waiting in the mailbox (AC-7)', async () => {
    await handler.execute(change());

    expect(otp.consume).toHaveBeenCalledWith(
      'RESET_PASSWORD',
      'jane@example.com',
    );
  });
});
