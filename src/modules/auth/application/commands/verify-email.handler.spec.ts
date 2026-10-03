import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { CredentialProvider } from '@prisma/client';
import { VerifyEmailHandler } from './verify-email.handler.js';
import { VerifyEmailCommand } from './verify-email.command.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import { AuthErrorCodes, UserErrorCodes } from '@/core/index.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { OtpService } from '../services/otp.service.js';
import type { SessionIssuer } from '../services/session-issuer.service.js';
import type { PendingSignupStore } from '../../infrastructure/index.js';

const CLIENT = { ip: '203.0.113.7', userAgent: 'Chrome' };
const TOKENS = { accessToken: 'at', refreshToken: 'rt' };
const PENDING = { passwordHash: '$argon2id$stored-hash', displayName: 'Jane' };
const PASSWORD = 'Sunny-Giraffe-42!';
const verify = (password = PASSWORD) =>
  new VerifyEmailCommand('new@example.com', '482915', password, CLIENT);

describe('VerifyEmailHandler', () => {
  let handler: VerifyEmailHandler;
  let calls: string[];
  let userRepo: { save: ReturnType<typeof vi.fn> };
  let otpService: {
    verify: ReturnType<typeof vi.fn>;
    consume: ReturnType<typeof vi.fn>;
  };
  let pendingSignups: {
    get: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let sessionIssuer: { start: ReturnType<typeof vi.fn> };

  const expectInvalidCode = (promise: Promise<unknown>) =>
    expect(promise).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.INVALID_VERIFICATION_CODE.code,
    );

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(HashUtil, 'comparePassword').mockImplementation(async () => {
      calls.push('check password');
      return true;
    });
    calls = [];
    userRepo = {
      save: vi.fn().mockImplementation(async () => {
        calls.push('save user');
      }),
    };
    otpService = {
      verify: vi.fn().mockImplementation(async () => {
        calls.push('verify code');
        return true;
      }),
      consume: vi.fn().mockImplementation(async () => {
        calls.push('consume code');
        return true;
      }),
    };
    pendingSignups = {
      get: vi.fn().mockImplementation(async () => {
        calls.push('read pending');
        return PENDING;
      }),
      delete: vi.fn().mockImplementation(async () => {
        calls.push('delete pending');
      }),
    };
    sessionIssuer = {
      start: vi.fn().mockImplementation(async () => {
        calls.push('start session');
        return TOKENS;
      }),
    };

    handler = new VerifyEmailHandler(
      userRepo as unknown as IUserRepository,
      otpService as unknown as OtpService,
      pendingSignups as unknown as PendingSignupStore,
      sessionIssuer as unknown as SessionIssuer,
    );
  });

  it('creates the account with the registered password hash and returns tokens (AC-2)', async () => {
    const result = await handler.execute(verify());

    expect(result).toEqual(TOKENS);
    const user = userRepo.save.mock.calls[0][0];
    expect(user.displayName).toBe('Jane');
    expect(user.credentials).toHaveLength(1);
    expect(user.credentials[0]).toMatchObject({
      provider: CredentialProvider.EMAIL,
      identifier: 'new@example.com',
      secret: PENDING.passwordHash,
    });
    expect(sessionIssuer.start).toHaveBeenCalledWith(user, CLIENT);
  });

  it('checks the code against this email and purpose', async () => {
    await handler.execute(verify());

    expect(otpService.verify).toHaveBeenCalledWith(
      'REGISTER_EMAIL',
      'new@example.com',
      '482915',
      CLIENT.ip,
    );
  });

  it('checks the password against the hash of the waiting registration (AC-15)', async () => {
    await handler.execute(verify());

    expect(HashUtil.comparePassword).toHaveBeenCalledWith(
      PASSWORD,
      PENDING.passwordHash,
    );
  });

  it('refuses a password that differs from the registration, leaving the code usable and creating nothing (AC-15)', async () => {
    vi.mocked(HashUtil.comparePassword).mockResolvedValue(false);

    await expect(
      handler.execute(verify('Another-Password-9')),
    ).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.REGISTRATION_PASSWORD_MISMATCH.code,
    );
    expect(otpService.consume).not.toHaveBeenCalled();
    expect(userRepo.save).not.toHaveBeenCalled();
    expect(sessionIssuer.start).not.toHaveBeenCalled();
  });

  it('does not check the password for a wrong code, so it cannot be used to burn CPU (AC-15)', async () => {
    otpService.verify.mockResolvedValue(false);

    await expectInvalidCode(handler.execute(verify()));
    expect(HashUtil.comparePassword).not.toHaveBeenCalled();
  });

  it('runs in a safe order: check the code, read pending, check the password, use the code up, create, drop the pending registration, log in', async () => {
    await handler.execute(verify());

    expect(calls).toEqual([
      'verify code',
      'read pending',
      'check password',
      'consume code',
      'save user',
      'delete pending',
      'start session',
    ]);
  });

  it('leaves no pending registration behind when starting the session fails after the account exists', async () => {
    sessionIssuer.start.mockRejectedValue(new ServiceUnavailableException());

    await expect(handler.execute(verify())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(pendingSignups.delete).toHaveBeenCalledOnce();
  });

  it('answers the generic invalid-code error for a wrong or expired code and creates nothing (AC-3, AC-4)', async () => {
    otpService.verify.mockResolvedValue(false);

    await expectInvalidCode(handler.execute(verify()));
    expect(pendingSignups.get).not.toHaveBeenCalled();
    expect(otpService.consume).not.toHaveBeenCalled();
    expect(userRepo.save).not.toHaveBeenCalled();
  });

  it('answers the same error when no registration is waiting for the address (AC-4)', async () => {
    pendingSignups.get.mockResolvedValue(null);

    await expectInvalidCode(handler.execute(verify()));
    expect(otpService.consume).not.toHaveBeenCalled();
    expect(userRepo.save).not.toHaveBeenCalled();
  });

  it('lets only one of two concurrent redemptions create the account: the one that loses the code gets the generic error (AC-12)', async () => {
    otpService.consume.mockResolvedValue(false);

    await expectInvalidCode(handler.execute(verify()));
    expect(userRepo.save).not.toHaveBeenCalled();
    expect(sessionIssuer.start).not.toHaveBeenCalled();
  });

  it('does not log anyone in when the account cannot be created, e.g. the address was taken meanwhile', async () => {
    userRepo.save.mockRejectedValue(
      Object.assign(new Error('taken'), {
        code: UserErrorCodes.EMAIL_ALREADY_EXISTS.code,
      }),
    );

    await expect(handler.execute(verify())).rejects.toThrow('taken');
    expect(sessionIssuer.start).not.toHaveBeenCalled();
  });

  it('still succeeds when tidying up the pending registration fails', async () => {
    pendingSignups.delete.mockRejectedValue(new ServiceUnavailableException());

    await expect(handler.execute(verify())).resolves.toEqual(TOKENS);
  });

  it('does not create an account when Redis is down (AC-13)', async () => {
    otpService.verify.mockRejectedValue(new ServiceUnavailableException());

    await expect(handler.execute(verify())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(userRepo.save).not.toHaveBeenCalled();
  });
});
