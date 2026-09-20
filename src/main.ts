import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AllExceptionsFilter } from './core/filters/all-exceptions.filter.js';
import { ResponseInterceptor } from './core/interceptors/response.interceptor.js';
import { LoggingInterceptor } from './core/interceptors/logging.interceptor.js';
import { AppLogger } from './core/logging/app.logger.js';

import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true, // Buffer logs until custom logger is attached
  });
  app.useLogger(new AppLogger());

  // Security Headers
  app.use(helmet());

  // CORS
  app.enableCors();

  // Graceful Shutdown
  app.enableShutdownHooks();

  // Global Prefix
  app.setGlobalPrefix('api/v1');

  // Validation & Filters & Interceptors
  const clsService = app.get(ClsService);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
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
