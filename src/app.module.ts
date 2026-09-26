import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { AppController } from './app.controller.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { validateEnv } from './core/config/env.validation.js';
import { resolveCorrelationId } from './core/utils/correlation-id.util.js';

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
    CatalogModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
