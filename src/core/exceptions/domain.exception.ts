import { ErrorCode } from './error-codes.js';

export class DomainException extends Error {
  public readonly code: string;
  public readonly details?: any;

  constructor(errorCode: ErrorCode, details?: any) {
    super(errorCode.message);
    this.name = 'DomainException';
    this.code = errorCode.code;
    this.details = details;
  }
}
