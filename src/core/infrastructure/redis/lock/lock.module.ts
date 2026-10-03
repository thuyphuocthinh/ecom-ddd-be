import { Global, Module } from '@nestjs/common';
import { LockService } from './lock.service.js';

@Global()
@Module({
  providers: [LockService],
  exports: [LockService],
})
export class LockModule {}
