import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { DomainException } from '../exceptions/domain.exception.js';
import { CoreErrorCodes } from '../exceptions/error-codes.js';
import { randomUUID } from 'crypto';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const traceId = randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = CoreErrorCodes.SYSTEM_ERROR.message;
    let code = CoreErrorCodes.SYSTEM_ERROR.code;
    let errors: any = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse() as any;

      if (status === HttpStatus.BAD_REQUEST && Array.isArray(res.message)) {
        message = CoreErrorCodes.VALIDATION_ERROR.message;
        code = CoreErrorCodes.VALIDATION_ERROR.code;
        errors = res.message;
      } else {
        message = res.message || exception.message;
        code = `HTTP_${status}`;
      }
    } else if (exception instanceof DomainException) {
      status = HttpStatus.BAD_REQUEST;
      message = exception.message;
      code = exception.code;
      errors = exception.details || null;
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    this.logger.error(
      `[${traceId}] ${request.method} ${request.url} - ${status} - ${message}`,
      exception instanceof Error ? exception.stack : '',
    );

    response.status(status).json({
      statusCode: status,
      code,
      message,
      ...(errors && { errors }),
      traceId,
      timestamp: new Date().toISOString(),
    });
  }
}
