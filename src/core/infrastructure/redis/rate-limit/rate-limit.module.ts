import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RateLimitService } from './rate-limit.service.js';
import { RateLimitInterceptor } from '../../../http/interceptors/rate-limit.interceptor.js';

// The interceptor is global but inert: it only acts on routes carrying @RateLimit().
@Global()
@Module({
  providers: [
    RateLimitService,
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
  ],
  exports: [RateLimitService],
})
export class RateLimitModule {}
