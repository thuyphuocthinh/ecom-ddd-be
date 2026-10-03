import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { ForgotPasswordHandler } from './forgot-password.handler.js';
import { ForgotPasswordCommand } from './forgot-password.command.js';
import { AuthDomainException } from '../../domain/index.js';
import { AuthErrorCodes, CACHE } from '@/core/index.js';
import type { IJobQueue, JobPayloadCipher } from '@/core/index.js';
import type { OtpService } from '../services/otp.service.js';
import { REQUEST_PASSWORD_RESET } from '../jobs/request-password-reset.job.js';

describe('ForgotPasswordHandler', () => {
  let handler: ForgotPasswordHandler;
  let calls: string[];
  let otp: {
    reserveSend: ReturnType<typeof vi.fn>;
    releaseSend: ReturnType<typeof vi.fn>;
  };
  let jobs: { enqueue: ReturnType<typeof vi.fn> };
  let cipher: { encrypt: ReturnType<typeof vi.fn> };

  const forgot = (email: string) => new ForgotPasswordCommand(email);

  beforeEach(() => {
    calls = [];
    otp = {
      reserveSend: vi.fn().mockImplementation(async () => {
        calls.push('reserve send');
      }),
      releaseSend: vi.fn().mockImplementation(async () => {
        calls.push('release send');
      }),
    };
    jobs = {
      enqueue: vi.fn().mockImplementation(async () => {
        calls.push('enqueue');
      }),
    };
    cipher = { encrypt: vi.fn().mockReturnValue('ENCRYPTED') };

    handler = new ForgotPasswordHandler(
      otp as unknown as OtpService,
      jobs as unknown as IJobQueue,
      cipher as unknown as JobPayloadCipher,
    );
  });

  it('asks permission to send, queues one job, and answers with the cooldown (AC-1)', async () => {
    const result = await handler.execute(forgot('jane@example.com'));

    expect(result).toEqual({
      resendAvailableInSeconds: CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
    });
    expect(calls).toEqual(['reserve send', 'enqueue']);
    expect(otp.reserveSend).toHaveBeenCalledWith(
      'RESET_PASSWORD',
      'jane@example.com',
    );
  });

  it('puts the address in the queue only in encrypted form (AC-2)', async () => {
    await handler.execute(forgot('jane@example.com'));

    expect(cipher.encrypt).toHaveBeenCalledWith({ email: 'jane@example.com' });
    expect(jobs.enqueue).toHaveBeenCalledWith(REQUEST_PASSWORD_RESET, {
      payload: 'ENCRYPTED',
    });
    expect(JSON.stringify(jobs.enqueue.mock.calls)).not.toContain('jane@');
  });

  it('answers 429 with the wait time and queues nothing when the address is in its cooldown (AC-1)', async () => {
    otp.reserveSend.mockRejectedValue(
      new AuthDomainException(AuthErrorCodes.RATE_LIMIT_EXCEEDED, {
        retryAfterSeconds: 217,
      }),
    );

    await expect(handler.execute(forgot('jane@example.com'))).rejects.toSatisfy(
      (e: any) =>
        e.code === AuthErrorCodes.RATE_LIMIT_EXCEEDED.code &&
        e.details.retryAfterSeconds === 217,
    );
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('gives the send slot back and fails when the job cannot be queued, for every address alike (AC-7)', async () => {
    jobs.enqueue.mockRejectedValue(new ServiceUnavailableException());

    await expect(
      handler.execute(forgot('jane@example.com')),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(otp.releaseSend).toHaveBeenCalledWith(
      'RESET_PASSWORD',
      'jane@example.com',
    );
  });

  it('answers 503 and queues nothing when Redis is down at the permission step (AC-14)', async () => {
    otp.reserveSend.mockRejectedValue(new ServiceUnavailableException());

    await expect(
      handler.execute(forgot('jane@example.com')),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
