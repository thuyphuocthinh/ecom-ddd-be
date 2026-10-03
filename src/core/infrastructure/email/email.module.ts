import { Global, Module } from '@nestjs/common';
import { EMAIL_SENDER } from './email-sender.port.js';
import { createEmailSender } from './email-sender.factory.js';

// Global: any feature (registration now, password reset and order mails later) can
// inject the sender without importing a feature module.
@Global()
@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      useFactory: () => createEmailSender(process.env),
    },
  ],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
