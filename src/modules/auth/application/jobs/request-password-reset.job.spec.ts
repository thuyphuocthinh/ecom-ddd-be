import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialProvider } from '@prisma/client';
import {
  REQUEST_PASSWORD_RESET,
  RequestPasswordResetJobHandler,
} from './request-password-reset.job.js';
import { JobPayloadCipher, type IJobQueue } from '@/core/index.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import type { OtpService } from '../services/otp.service.js';
import type { PasswordMailer } from '../services/password-mailer.service.js';

describe('request-password-reset job', () => {
  const cipher = new JobPayloadCipher('s'.repeat(32), 'jobs-password-reset-v1');
  const payload = () => ({
    payload: cipher.encrypt({ email: 'jane@example.com' }),
  });

  let jobs: { register: ReturnType<typeof vi.fn> };
  let userRepo: { findByCredential: ReturnType<typeof vi.fn> };
  let otp: { issue: ReturnType<typeof vi.fn> };
  let mailer: { sendResetCode: ReturnType<typeof vi.fn> };
  let handler: RequestPasswordResetJobHandler;

  beforeEach(() => {
    jobs = { register: vi.fn() };
    userRepo = {
      findByCredential: vi.fn().mockResolvedValue({
        id: 'user-1',
        credentials: [
          { provider: CredentialProvider.EMAIL, secret: '$argon2id$hash' },
        ],
      }),
    };
    otp = { issue: vi.fn().mockResolvedValue('482915') };
    mailer = { sendResetCode: vi.fn().mockResolvedValue(undefined) };
    handler = new RequestPasswordResetJobHandler(
      jobs as unknown as IJobQueue,
      userRepo as unknown as IUserRepository,
      otp as unknown as OtpService,
      mailer as unknown as PasswordMailer,
      cipher,
    );
  });

  it('retries after 10 s, 30 s and 90 s', () => {
    expect(REQUEST_PASSWORD_RESET.name).toBe('request-password-reset');
    expect(REQUEST_PASSWORD_RESET.retryDelaysMs).toEqual([
      10_000, 30_000, 90_000,
    ]);
  });

  it('registers itself for the job when the module starts', () => {
    handler.onModuleInit();

    expect(jobs.register).toHaveBeenCalledWith(
      REQUEST_PASSWORD_RESET,
      expect.any(Function),
    );
  });

  it('creates a reset code and emails it when the address has an account (AC-2)', async () => {
    await handler.handle(payload());

    expect(userRepo.findByCredential).toHaveBeenCalledWith(
      CredentialProvider.EMAIL,
      'jane@example.com',
    );
    expect(otp.issue).toHaveBeenCalledWith(
      'RESET_PASSWORD',
      'jane@example.com',
    );
    expect(mailer.sendResetCode).toHaveBeenCalledWith(
      'jane@example.com',
      '482915',
    );
  });

  it('does nothing at all for an address with no account: no code stored, no email (AC-2)', async () => {
    userRepo.findByCredential.mockResolvedValue(null);

    await expect(handler.handle(payload())).resolves.toBeUndefined();

    expect(otp.issue).not.toHaveBeenCalled();
    expect(mailer.sendResetCode).not.toHaveBeenCalled();
  });

  it('does nothing for an account that has no email password', async () => {
    userRepo.findByCredential.mockResolvedValue({
      id: 'user-2',
      credentials: [{ provider: CredentialProvider.EMAIL, secret: null }],
    });

    await handler.handle(payload());

    expect(mailer.sendResetCode).not.toHaveBeenCalled();
  });

  it('lets a failure to queue the email through, so the job is retried (AC-12)', async () => {
    mailer.sendResetCode.mockRejectedValue(new Error('queue down'));

    await expect(handler.handle(payload())).rejects.toThrow('queue down');
  });

  it('fails on a payload it cannot decrypt instead of guessing an address', async () => {
    await expect(handler.handle({ payload: 'garbage' })).rejects.toThrow();

    expect(userRepo.findByCredential).not.toHaveBeenCalled();
  });
});
