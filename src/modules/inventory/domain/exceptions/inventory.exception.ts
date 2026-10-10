import {
  DomainException,
  InventoryErrorCodes,
  type ErrorCode,
} from '@/core/index.js';

/** One SKU the order asked for more of than is available. */
export interface Shortage {
  skuId: string;
  requested: number;
  available: number;
}

export class InventoryDomainException extends DomainException {
  constructor(error: ErrorCode, customMessage?: string, details?: unknown) {
    super(
      {
        code: error.code,
        message: customMessage || error.message,
        status: error.status,
      },
      details,
    );
  }

  /** Not enough stock: carries every SKU that is short, not only the first. */
  static outOfStock(shortages: Shortage[]): InventoryDomainException {
    return new InventoryDomainException(
      InventoryErrorCodes.OUT_OF_STOCK,
      undefined,
      { shortages },
    );
  }
}
