import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { DomainException } from '../../domain/exceptions/domain.exception.js';
import { CoreErrorCodes } from '../../domain/exceptions/error-codes.js';
import { randomUUID } from 'crypto';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly cls: ClsService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const traceId = this.cls.getId() || randomUUID();

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
      status = exception.status;
      message = exception.message;
      code = exception.code;
      errors = exception.details || null;
      // A refusal that says when to come back also says so in the standard header
      const retryAfter = (exception.details as { retryAfterSeconds?: unknown })
        ?.retryAfterSeconds;
      if (typeof retryAfter === 'number' && retryAfter > 0) {
        response.setHeader('Retry-After', String(Math.ceil(retryAfter)));
      }
    } else if (isMulterError(exception)) {
      // A bad upload (wrong field name, too many files, too big). Nest maps only some of
      // multer's messages, so the rest would surface as a 500; they are all the sender's doing.
      status =
        exception.code === 'LIMIT_FILE_SIZE'
          ? HttpStatus.PAYLOAD_TOO_LARGE
          : HttpStatus.BAD_REQUEST;
      message = exception.message;
      code = `HTTP_${status}`;
    }
    // Anything else is an unexpected failure (Prisma, Redis, a bug...). Its message
    // can carry SQL, table/column names or connection details, so the client only
    // gets the generic 500 message; the real error is logged below.

    // Ghi log lỗi, AppLogger sẽ tự động thêm [TraceId-...] ở đầu nên không cần thêm thủ công ở đây
    this.logger.error(
      `${request.method} ${request.url} - ${status} - ${message}`,
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

interface MulterErrorLike extends Error {
  code: string;
}

/** multer's own error, recognised by name so this file does not depend on the multer package. */
function isMulterError(exception: unknown): exception is MulterErrorLike {
  return (
    exception instanceof Error &&
    exception.name === 'MulterError' &&
    typeof (exception as { code?: unknown }).code === 'string'
  );
}
