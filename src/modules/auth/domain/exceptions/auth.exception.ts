import { DomainException, ErrorCode } from '@/core/index.js';

export class AuthDomainException extends DomainException {
  constructor(
    public readonly error: ErrorCode,
    message?: string,
  ) {
    super(error, message);
  }
}
