import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'crypto';
import { AppController } from './app.controller.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) =>
          (req.headers['x-correlation-id'] as string) || randomUUID(),
      },
    }),
    CatalogModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
