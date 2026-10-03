import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ArgumentsHost,
  BadRequestException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { DomainException } from '../../domain/exceptions/domain.exception.js';
import {
  AuthErrorCodes,
  CoreErrorCodes,
} from '../../domain/exceptions/error-codes.js';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let json: ReturnType<typeof vi.fn>;
  let status: ReturnType<typeof vi.fn>;
  let setHeader: ReturnType<typeof vi.fn>;
  let host: ArgumentsHost;

  const respond = (exception: unknown) => {
    filter.catch(exception, host);
    return {
      status: status.mock.calls[0][0] as number,
      body: json.mock.calls[0][0],
    };
  };

  beforeEach(() => {
    json = vi.fn();
    status = vi.fn().mockReturnValue({ json });
    setHeader = vi.fn();
    host = {
      switchToHttp: () => ({
        getResponse: () => ({ status, setHeader }),
        getRequest: () => ({ method: 'POST', url: '/api/v1/auth/register' }),
      }),
    } as unknown as ArgumentsHost;
    filter = new AllExceptionsFilter({
      getId: () => 'trace-1',
    } as unknown as ClsService);
  });

  it('keeps the message and code of a DomainException', () => {
    const { status: s, body } = respond(
      new DomainException(
        AuthErrorCodes.INVALID_CREDENTIALS,
        'Invalid email or password',
      ),
    );

    expect(s).toBe(HttpStatus.UNAUTHORIZED);
    expect(body).toMatchObject({
      code: AuthErrorCodes.INVALID_CREDENTIALS.code,
      message: 'Invalid email or password',
      traceId: 'trace-1',
    });
  });

  it('tells the client how long to wait: in the body and in the Retry-After header', () => {
    const { status: s, body } = respond(
      new DomainException(AuthErrorCodes.RATE_LIMIT_EXCEEDED, {
        retryAfterSeconds: 217.2,
      }),
    );

    expect(s).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body.errors).toEqual({ retryAfterSeconds: 217.2 });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '218');
  });

  it('sets no Retry-After header when the error carries no wait time', () => {
    respond(new DomainException(AuthErrorCodes.INVALID_CREDENTIALS, 'nope'));

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('keeps the message of an HttpException', () => {
    const { status: s, body } = respond(
      new NotFoundException('Product not found'),
    );

    expect(s).toBe(HttpStatus.NOT_FOUND);
    expect(body).toMatchObject({
      code: 'HTTP_404',
      message: 'Product not found',
    });
  });

  it('turns class-validator failures into a VALIDATION_ERROR with the field errors', () => {
    const { status: s, body } = respond(
      new BadRequestException({ message: ['email must be an email'] }),
    );

    expect(s).toBe(HttpStatus.BAD_REQUEST);
    expect(body).toMatchObject({
      code: CoreErrorCodes.VALIDATION_ERROR.code,
      errors: ['email must be an email'],
    });
  });

  describe('unexpected errors', () => {
    it('never puts the raw error message in the response (it can carry SQL / schema details)', () => {
      const prismaLike = new Error(
        'Unique constraint failed on the fields: (`provider`,`identifier`)',
      );

      const { status: s, body } = respond(prismaLike);

      expect(s).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body.message).toBe(CoreErrorCodes.SYSTEM_ERROR.message);
      expect(body.code).toBe(CoreErrorCodes.SYSTEM_ERROR.code);
      expect(JSON.stringify(body)).not.toContain('provider');
      expect(JSON.stringify(body)).not.toContain('identifier');
    });

    it('never puts the stack trace in the response', () => {
      const { body } = respond(new Error('boom'));

      expect(body).not.toHaveProperty('stack');
    });

    it('handles a thrown non-Error value', () => {
      const { status: s, body } = respond('just a string');

      expect(s).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body.message).toBe(CoreErrorCodes.SYSTEM_ERROR.message);
    });
  });

  describe('upload errors from multer', () => {
    const multerError = (code: string, message: string) =>
      Object.assign(new Error(message), { name: 'MulterError', code });

    it('answers 413 for a file that is too large', () => {
      const { status: s, body } = respond(
        multerError('LIMIT_FILE_SIZE', 'File too large'),
      );

      expect(s).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
      expect(body.message).toBe('File too large');
    });

    it.each([
      ['LIMIT_UNEXPECTED_FILE', 'Unexpected file field'],
      ['LIMIT_FILE_COUNT', 'Too many files'],
      ['INVALID_FIELD_NAME', 'Invalid field name'],
    ])('answers 400, not 500, for %s', (code, message) => {
      const { status: s, body } = respond(multerError(code, message));

      expect(s).toBe(HttpStatus.BAD_REQUEST);
      expect(body).toMatchObject({ code: 'HTTP_400', message });
    });

    it('does not mistake an ordinary error for an upload error', () => {
      const { status: s } = respond(new Error('MulterError'));

      expect(s).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });
});
