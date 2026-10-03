import { DomainException, ErrorCode } from '@/core/index.js';

export class UserDomainException extends DomainException {
  constructor(
    public readonly error: ErrorCode,
    details?: unknown,
  ) {
    super(error, details);
  }
}
