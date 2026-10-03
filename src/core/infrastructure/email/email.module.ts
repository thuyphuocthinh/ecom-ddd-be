import { Global, Module } from '@nestjs/common';
import { EMAIL_SENDER } from './email-sender.port.js';
import { EMAIL_DISPATCHER } from './email-dispatcher.port.js';
import { createEmailSender } from './email-sender.factory.js';
import { JobPayloadCipher } from '../messaging/jobs/job-payload-cipher.js';
import {
  EMAIL_PAYLOAD_CIPHER,
  EmailDispatcher,
  EmailJobHandler,
} from './email.job.js';

// Global: any feature (registration now, password reset and order mails later) can
// inject the dispatcher without importing a feature module.
@Global()
@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      useFactory: () => createEmailSender(process.env),
    },
    {
      provide: EMAIL_PAYLOAD_CIPHER,
      useFactory: () =>
        new JobPayloadCipher(
          process.env.JWT_ACCESS_SECRET as string,
          'jobs-email-v1',
        ),
    },
    { provide: EMAIL_DISPATCHER, useClass: EmailDispatcher },
    EmailJobHandler,
  ],
  exports: [EMAIL_SENDER, EMAIL_DISPATCHER],
})
export class EmailModule {}
