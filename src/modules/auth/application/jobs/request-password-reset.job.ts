import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { CredentialProvider } from '@prisma/client';
import {
  JOB_QUEUE,
  defineJob,
  type IJobQueue,
  type JobPayloadCipher,
} from '@/core/index.js';
import type { IUserRepository as IUserRepositoryType } from '../../../users/domain/index.js';
import { OtpService } from '../services/otp.service.js';
import { PasswordMailer } from '../services/password-mailer.service.js';

/** DI token for the cipher that protects the data of this job in the queue. */
export const PASSWORD_RESET_PAYLOAD_CIPHER = 'PASSWORD_RESET_PAYLOAD_CIPHER';

/** What travels through the queue: the email address, encrypted. */
export interface RequestPasswordResetJobData {
  payload: string;
}

/** What is inside the encrypted payload. */
export interface PasswordResetRequest {
  email: string;
}

/**
 * The work behind "forgot my password": look the account up, create a code, email it.
 * It runs as a background job, the same job for every address, so the answer to the person
 * asking never depends on whether the address has an account.
 */
export const REQUEST_PASSWORD_RESET = defineJob<RequestPasswordResetJobData>({
  name: 'request-password-reset',
  retryDelaysMs: [10_000, 30_000, 90_000],
  concurrency: 5,
});

@Injectable()
export class RequestPasswordResetJobHandler implements OnModuleInit {
  constructor(
    @Inject(JOB_QUEUE) private readonly jobs: IJobQueue,
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    private readonly otpService: OtpService,
    private readonly mailer: PasswordMailer,
    @Inject(PASSWORD_RESET_PAYLOAD_CIPHER)
    private readonly cipher: JobPayloadCipher,
  ) {}

  onModuleInit(): void {
    this.jobs.register(REQUEST_PASSWORD_RESET, (data) => this.handle(data));
  }

  async handle(data: RequestPasswordResetJobData): Promise<void> {
    const { email } = this.cipher.decrypt<PasswordResetRequest>(data.payload);

    const user = await this.userRepo.findByCredential(
      CredentialProvider.EMAIL,
      email,
    );
    const hasPassword = user?.credentials.some(
      (credential) =>
        credential.provider === CredentialProvider.EMAIL && credential.secret,
    );
    // No account with a password for this address: nothing to do, and nothing to tell anyone
    if (!user || !hasPassword) return;

    const code = await this.otpService.issue('RESET_PASSWORD', email);
    await this.mailer.sendResetCode(email, code);
  }
}
