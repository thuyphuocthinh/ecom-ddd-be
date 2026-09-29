import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { AppController } from './app.controller.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { validateEnv } from './core/config/env.validation.js';
import { resolveCorrelationId } from './core/utils/correlation-id.util.js';
import { DatabaseModule } from './core/infrastructure/database/database.module.js';
import { RedisModule } from './core/infrastructure/redis/redis.module.js';
import { IdempotencyModule } from './core/infrastructure/idempotency/idempotency.module.js';
import { RateLimitModule } from './core/infrastructure/rate-limit/rate-limit.module.js';
import { TokenModule } from './core/infrastructure/token/token.module.js';

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
    UsersModule,
    AuthModule,
    CatalogModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
