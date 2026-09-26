import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes.js';

export class DomainException extends Error {
  public readonly code: string;
  public readonly status: HttpStatus;
  public readonly details?: unknown;

  constructor(errorCode: ErrorCode, details?: unknown) {
    super(errorCode.message);
    this.name = 'DomainException';
    this.code = errorCode.code;
    this.status = errorCode.status;
    this.details = details;
  }
}
