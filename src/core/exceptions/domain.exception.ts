import { ErrorCode } from './error-codes.js';

export class DomainException extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(errorCode: ErrorCode, details?: unknown) {
    super(errorCode.message);
    this.name = 'DomainException';
    this.code = errorCode.code;
    this.details = details;
  }
}
