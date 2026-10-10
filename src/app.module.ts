import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { AppController } from './app.controller.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { LocationsModule } from './modules/locations/locations.module.js';
import { validateEnv } from './core/config/env.validation.js';
import { resolveCorrelationId } from './core/utils/correlation-id.util.js';
import { DatabaseModule } from './core/infrastructure/database/database.module.js';
import { RedisModule } from './core/infrastructure/redis/redis.module.js';
import { IdempotencyModule } from './core/infrastructure/redis/idempotency/idempotency.module.js';
import { RateLimitModule } from './core/infrastructure/redis/rate-limit/rate-limit.module.js';
import { LockModule } from './core/infrastructure/redis/lock/lock.module.js';
import { TokenModule } from './core/infrastructure/redis/token/token.module.js';
import { JobQueueModule } from './core/infrastructure/messaging/jobs/job-queue.module.js';
import { EmailModule } from './core/infrastructure/email/email.module.js';
import { ImageStorageModule } from './core/infrastructure/storage/image-storage.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: resolveCorrelationId,
      },
    }),
    DatabaseModule,
    RedisModule,
    IdempotencyModule,
    RateLimitModule,
    TokenModule,
    LockModule,
    JobQueueModule,
    EmailModule,
    ImageStorageModule,
    UsersModule,
    AuthModule,
    CatalogModule,
    InventoryModule,
    LocationsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
