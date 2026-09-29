import { DomainException, ErrorCode } from '@/core/index.js';
import { UserErrorCodes } from '@/core/domain/exceptions/error-codes.js';

export class UserDomainException extends DomainException {
  constructor(
    public readonly error: ErrorCode,
    message?: string,
  ) {
    super(error, message);
  }
}
