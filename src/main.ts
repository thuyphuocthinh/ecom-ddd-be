import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AllExceptionsFilter } from './core/http/filters/all-exceptions.filter.js';
import { ResponseInterceptor } from './core/http/interceptors/response.interceptor.js';
import { LoggingInterceptor } from './core/http/interceptors/logging.interceptor.js';
import { AppLogger } from './core/http/logging/app.logger.js';

import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true, // Buffer logs until custom logger is attached
    rawBody: true, // A webhook signature is checked against the exact bytes that arrived
  });
  app.useLogger(new AppLogger());

  // Security Headers
  app.use(helmet());

  // CORS — restrict origins in production via CORS_ORIGINS env var
  // Example: CORS_ORIGINS=https://ecom.com,https://admin.ecom.com
  const rawOrigins = process.env.CORS_ORIGINS;
  app.enableCors({
    origin: rawOrigins ? rawOrigins.split(',').map((o) => o.trim()) : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    // A browser on another origin can only read these response headers if they are listed: a
    // repeated request is told apart from a new one by Idempotency-Replayed
    exposedHeaders: ['Idempotency-Replayed'],
    credentials: false, // tokens are in body, not cookies
  });

  // Graceful Shutdown
  app.enableShutdownHooks();

  // Global Prefix
  app.setGlobalPrefix('api/v1');

  // Validation & Filters & Interceptors
  const clsService = app.get(ClsService);

  // Body size limit — reject oversized payloads before they hit any handler
  // Prevents naive DoS via huge JSON body. 1 MB is generous for an API.
  // (useBodyParser, not app.use(json()): it keeps the raw body the webhook signature needs)
  app.useBodyParser('json', { limit: '1mb' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields silently
      forbidNonWhitelisted: true, // AND reject request if unknown fields present
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(clsService));
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new ResponseInterceptor(),
  );

  // Swagger Documentation
  const config = new DocumentBuilder()
    .setTitle('E-Commerce API')
    .setDescription(
      'Tài liệu API cho hệ thống E-commerce (Catalog, Inventory, Order, v.v...)',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
