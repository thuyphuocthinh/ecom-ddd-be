import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { RegisterHandler } from './register.handler.js';
import { RegisterCommand } from './register.command.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import { AuthDomainException } from '../../domain/index.js';
import {
  AuthErrorCodes,
  CACHE,
  UserErrorCodes,
  type AppConfig,
} from '@/core/index.js';
import type { OtpService } from '../services/otp.service.js';
import type { VerificationMailer } from '../services/verification-mailer.service.js';
import type { PendingSignupStore } from '../../infrastructure/index.js';

const command = (displayName?: string) =>
  new RegisterCommand('new@example.com', 'Sunny-Giraffe-42!', displayName);

describe('RegisterHandler', () => {
  let handler: RegisterHandler;
  let calls: string[];
  let userRepo: { findByCredential: ReturnType<typeof vi.fn> };
  let otpService: {
    reserveSend: ReturnType<typeof vi.fn>;
    issue: ReturnType<typeof vi.fn>;
    releaseSend: ReturnType<typeof vi.fn>;
  };
  let pendingSignups: { save: ReturnType<typeof vi.fn> };
  let mailer: { sendCode: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    calls = [];
    userRepo = { findByCredential: vi.fn().mockResolvedValue(null) };
    otpService = {
      reserveSend: vi.fn().mockImplementation(async () => {
        calls.push('reserve send');
      }),
      issue: vi.fn().mockImplementation(async () => {
        calls.push('issue code');
        return '482915';
      }),
      releaseSend: vi.fn().mockImplementation(async () => {
        calls.push('release send');
      }),
    };
    pendingSignups = {
      save: vi.fn().mockImplementation(async () => {
        calls.push('save pending');
      }),
    };
    mailer = {
      sendCode: vi.fn().mockImplementation(async () => {
        calls.push('send email');
        return true;
      }),
    };

    handler = new RegisterHandler(
      userRepo as unknown as IUserRepository,
      otpService as unknown as OtpService,
      pendingSignups as unknown as PendingSignupStore,
      mailer as unknown as VerificationMailer,
      { name: 'Ecom' } as AppConfig,
    );
  });

  describe('password policy', () => {
    const attempt = (password: string, email = 'new.person@example.com') =>
      handler.execute(new RegisterCommand(email, password));

    it.each([
      ['Password123!', 'COMMON'],
      ['aaaaaaaa', 'REPEATED_OR_SEQUENTIAL'],
      ['xx-new.person-9Z', 'CONTAINS_EMAIL'],
      ['I love Ecom 2026', 'CONTAINS_APP_NAME'],
    ])(
      'refuses "%s" as %s and does nothing else: no lookup, no cooldown slot, no email',
      async (password, reason) => {
        await expect(attempt(password)).rejects.toSatisfy(
          (e: any) =>
            e.code === AuthErrorCodes.WEAK_PASSWORD.code &&
            e.details?.reason === reason,
        );
        expect(userRepo.findByCredential).not.toHaveBeenCalled();
        expect(otpService.reserveSend).not.toHaveBeenCalled();
        expect(pendingSignups.save).not.toHaveBeenCalled();
        expect(mailer.sendCode).not.toHaveBeenCalled();
      },
    );

    it('lets an ordinary password through', async () => {
      await expect(attempt('7-purple-Giraffes-dance')).resolves.toMatchObject({
        verificationRequired: true,
      });
    });
  });

  it('keeps a pending registration and emails a code, without creating an account (AC-1)', async () => {
    const result = await handler.execute(command('Jane'));

    expect(result).toEqual({
      verificationRequired: true,
      resendAvailableInSeconds: CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
      verificationExpiresInSeconds: CACHE.AUTH.SETTINGS.PENDING_SIGNUP_TTL,
    });
    expect(otpService.issue).toHaveBeenCalledWith(
      'REGISTER_EMAIL',
      'new@example.com',
    );
    expect(mailer.sendCode).toHaveBeenCalledWith('new@example.com', '482915');
  });

  it('never returns the code', async () => {
    const result = await handler.execute(command());

    expect(JSON.stringify(result)).not.toContain('482915');
  });

  it('stores the password only as an argon2 hash, with the display name', async () => {
    await handler.execute(command('Jane'));

    const [email, pending] = pendingSignups.save.mock.calls[0];
    expect(email).toBe('new@example.com');
    expect(pending.displayName).toBe('Jane');
    expect(pending.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(pending)).not.toContain('Sunny-Giraffe-42!');
  });

  it('stores no display name as null', async () => {
    await handler.execute(command());

    expect(pendingSignups.save.mock.calls[0][1].displayName).toBeNull();
  });

  it('asks permission to send BEFORE saving the registration, so a refusal cannot overwrite an earlier one (AC-9)', async () => {
    await handler.execute(command());

    expect(calls).toEqual([
      'reserve send',
      'issue code',
      'save pending',
      'send email',
    ]);
  });

  it('answers 429 and leaves the earlier pending registration alone when the address is in cooldown (AC-9)', async () => {
    otpService.reserveSend.mockRejectedValue(
      new AuthDomainException(AuthErrorCodes.RATE_LIMIT_EXCEEDED),
    );

    await expect(handler.execute(command())).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.RATE_LIMIT_EXCEEDED.code,
    );
    expect(otpService.issue).not.toHaveBeenCalled();
    expect(pendingSignups.save).not.toHaveBeenCalled();
    expect(mailer.sendCode).not.toHaveBeenCalled();
  });

  it('answers EMAIL_ALREADY_EXISTS for an address that already has an account, and sends nothing (AC-8)', async () => {
    userRepo.findByCredential.mockResolvedValue({ id: 'existing' });

    await expect(handler.execute(command())).rejects.toSatisfy(
      (e: any) => e.code === UserErrorCodes.EMAIL_ALREADY_EXISTS.code,
    );
    expect(otpService.reserveSend).not.toHaveBeenCalled();
    expect(pendingSignups.save).not.toHaveBeenCalled();
    expect(mailer.sendCode).not.toHaveBeenCalled();
  });

  it('does not report success when Redis is down, and sends no email (AC-13)', async () => {
    pendingSignups.save.mockRejectedValue(new ServiceUnavailableException());

    await expect(handler.execute(command())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mailer.sendCode).not.toHaveBeenCalled();
  });
});
