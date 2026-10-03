import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { ResendVerificationHandler } from './resend-verification.handler.js';
import { ResendVerificationCommand } from './resend-verification.command.js';
import { AuthDomainException } from '../../domain/index.js';
import { AuthErrorCodes, CACHE } from '@/core/index.js';
import type { OtpService } from '../services/otp.service.js';
import type { VerificationMailer } from '../services/verification-mailer.service.js';
import type { PendingSignupStore } from '../../infrastructure/index.js';

const resend = (email = 'new@example.com') =>
  new ResendVerificationCommand(email);

describe('ResendVerificationHandler', () => {
  let handler: ResendVerificationHandler;
  let otpService: {
    reserveSend: ReturnType<typeof vi.fn>;
    issue: ReturnType<typeof vi.fn>;
    releaseSend: ReturnType<typeof vi.fn>;
  };
  let pendingSignups: { get: ReturnType<typeof vi.fn> };
  let mailer: { sendCode: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    otpService = {
      reserveSend: vi.fn().mockResolvedValue(undefined),
      issue: vi.fn().mockResolvedValue('482915'),
      releaseSend: vi.fn().mockResolvedValue(undefined),
    };
    pendingSignups = {
      get: vi.fn().mockResolvedValue({ passwordHash: 'h', displayName: null }),
    };
    mailer = { sendCode: vi.fn().mockResolvedValue(undefined) };

    handler = new ResendVerificationHandler(
      otpService as unknown as OtpService,
      pendingSignups as unknown as PendingSignupStore,
      mailer as unknown as VerificationMailer,
    );
  });

  it('sends a fresh code to an address with a registration waiting (AC-5)', async () => {
    const result = await handler.execute(resend());

    expect(result).toEqual({
      resendAvailableInSeconds: CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
    });
    expect(otpService.issue).toHaveBeenCalledWith(
      'REGISTER_EMAIL',
      'new@example.com',
    );
    expect(mailer.sendCode).toHaveBeenCalledWith('new@example.com', '482915');
  });

  it('says so, with 404, when no registration is waiting, and sends nothing (AC-7)', async () => {
    pendingSignups.get.mockResolvedValue(null);

    await expect(
      handler.execute(resend('nobody@example.com')),
    ).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.NO_PENDING_REGISTRATION.code,
    );
    expect(otpService.issue).not.toHaveBeenCalled();
    expect(mailer.sendCode).not.toHaveBeenCalled();
  });

  it('does not spend any of the address allowance when there was nothing to send (AC-7)', async () => {
    pendingSignups.get.mockResolvedValue(null);

    await handler.execute(resend()).catch(() => undefined);

    expect(otpService.reserveSend).not.toHaveBeenCalled();
  });

  it('applies the cooldown and hourly allowance to a real send (AC-5, AC-6)', async () => {
    await handler.execute(resend());

    expect(otpService.reserveSend).toHaveBeenCalledWith(
      'REGISTER_EMAIL',
      'new@example.com',
    );
  });

  it('answers 429 when the address is over its limit, and sends nothing (AC-5, AC-6)', async () => {
    otpService.reserveSend.mockRejectedValue(
      new AuthDomainException(AuthErrorCodes.RATE_LIMIT_EXCEEDED),
    );

    await expect(handler.execute(resend())).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.RATE_LIMIT_EXCEEDED.code,
    );
    expect(otpService.issue).not.toHaveBeenCalled();
    expect(mailer.sendCode).not.toHaveBeenCalled();
  });

  it('gives the slot back and fails when the queue cannot take the email, so the user can ask again at once (AC-7)', async () => {
    mailer.sendCode.mockRejectedValue(new ServiceUnavailableException());

    await expect(handler.execute(resend())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(otpService.releaseSend).toHaveBeenCalledWith(
      'REGISTER_EMAIL',
      'new@example.com',
    );
  });

  it('keeps the slot once the email is with the queue (AC-5)', async () => {
    await handler.execute(resend());

    expect(otpService.releaseSend).not.toHaveBeenCalled();
  });

  it('gives the slot back when the code could not be stored, and still fails (AC-10)', async () => {
    otpService.issue.mockRejectedValue(new ServiceUnavailableException());

    await expect(handler.execute(resend())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(otpService.releaseSend).toHaveBeenCalledOnce();
    expect(mailer.sendCode).not.toHaveBeenCalled();
  });

  it('does not report success when Redis is down (AC-13)', async () => {
    pendingSignups.get.mockRejectedValue(new ServiceUnavailableException());

    await expect(handler.execute(resend())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
