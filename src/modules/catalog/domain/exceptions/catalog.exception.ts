import { DomainException, CatalogErrorCodes, ErrorCode } from '@/core/index.js';

export class CatalogDomainException extends DomainException {
  constructor(error: ErrorCode, customMessage?: string) {
    super({
      code: error.code,
      message: customMessage || error.message,
      status: error.status,
    });
  }
}
