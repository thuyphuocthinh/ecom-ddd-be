export interface ErrorCode {
  code: string;
  message: string;
}

export const CoreErrorCodes = {
  SYSTEM_ERROR: { code: 'SYS-001', message: 'Internal server error' },
  VALIDATION_ERROR: { code: 'VAL-001', message: 'Validation failed' },
};

export const OrderErrorCodes = {
  OUT_OF_STOCK: { code: 'ORD-001', message: 'Not enough stock available' },
  NOT_FOUND: { code: 'ORD-002', message: 'Order not found' },
};
