import { DomainException, ErrorCode } from '@/core/index.js';

export class CartDomainException extends DomainException {
  constructor(
    public readonly error: ErrorCode,
    details?: unknown,
  ) {
    super(error, details);
  }
}
