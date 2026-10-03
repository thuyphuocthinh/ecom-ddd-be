import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  defineJob,
  JOB_QUEUE,
  type IJobQueue,
} from '../messaging/jobs/job-queue.port.js';
import {
  EMAIL_SENDER,
  type EmailMessage,
  type IEmailSender,
} from './email-sender.port.js';
import type { IEmailDispatcher } from './email-dispatcher.port.js';
import { JobPayloadCipher } from '../messaging/jobs/job-payload-cipher.js';

/** DI token for the cipher that protects email payloads in the queue. */
export const EMAIL_PAYLOAD_CIPHER = 'EMAIL_PAYLOAD_CIPHER';

/** What travels through the queue: the whole email, encrypted. */
export interface SendEmailJobData {
  payload: string;
}

/**
 * Sending an email in the background. Retries after 10 s, 30 s and 90 s; after that the
 * job is set aside in the dead-letter queue. Up to 5 emails are sent at the same time.
 */
export const SEND_EMAIL = defineJob<SendEmailJobData>({
  name: 'send-email',
  retryDelaysMs: [10_000, 30_000, 90_000],
  concurrency: 5,
});

/** Accepts emails by putting them on the job queue. */
@Injectable()
export class EmailDispatcher implements IEmailDispatcher {
  constructor(
    @Inject(JOB_QUEUE) private readonly jobs: IJobQueue,
    @Inject(EMAIL_PAYLOAD_CIPHER) private readonly cipher: JobPayloadCipher,
  ) {}

  dispatch(message: EmailMessage): Promise<void> {
    return this.jobs.enqueue(SEND_EMAIL, {
      payload: this.cipher.encrypt(message),
    });
  }
}

/** Runs the `send-email` jobs: decrypt, then send. A failure is rethrown so the job is retried. */
@Injectable()
export class EmailJobHandler implements OnModuleInit {
  constructor(
    @Inject(JOB_QUEUE) private readonly jobs: IJobQueue,
    @Inject(EMAIL_SENDER) private readonly sender: IEmailSender,
    @Inject(EMAIL_PAYLOAD_CIPHER) private readonly cipher: JobPayloadCipher,
  ) {}

  onModuleInit(): void {
    this.jobs.register(SEND_EMAIL, (data) => this.handle(data));
  }

  async handle(data: SendEmailJobData): Promise<void> {
    await this.sender.send(this.cipher.decrypt(data.payload));
  }
}
