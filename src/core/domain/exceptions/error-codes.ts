import { HttpStatus } from '@nestjs/common';

export interface ErrorCode {
  code: string;
  message: string;
  status: HttpStatus;
}

export const CoreErrorCodes = {
  SYSTEM_ERROR: {
    code: 'SYS-001',
    message: 'Internal server error',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
  },
  VALIDATION_ERROR: {
    code: 'VAL-001',
    message: 'Validation failed',
    status: HttpStatus.BAD_REQUEST,
  },
};

export const OrderErrorCodes = {
  OUT_OF_STOCK: {
    code: 'ORD-001',
    message: 'Not enough stock available',
    status: HttpStatus.CONFLICT,
  },
  NOT_FOUND: {
    code: 'ORD-002',
    message: 'Order not found',
    status: HttpStatus.NOT_FOUND,
  },
};

export const CatalogErrorCodes = {
  DOMAIN_EXCEPTION: {
    code: 'CAT-000',
    message: 'Catalog domain exception',
    status: HttpStatus.BAD_REQUEST,
  },
  MAX_DEPTH_EXCEEDED: {
    code: 'CAT-001',
    message: 'Max category depth exceeded',
    status: HttpStatus.BAD_REQUEST,
  },
  SKU_DUPLICATED: {
    code: 'CAT-002',
    message: 'SKU attributes already exist in this product',
    status: HttpStatus.CONFLICT,
  },
  INVALID_PUBLISH: {
    code: 'CAT-003',
    message: 'Cannot publish product without SKUs',
    status: HttpStatus.BAD_REQUEST,
  },
  CATEGORY_HAS_CHILDREN: {
    code: 'CAT-004',
    message: 'Cannot add product to a category that has children',
    status: HttpStatus.CONFLICT,
  },
  CATEGORY_NOT_FOUND: {
    code: 'CAT-005',
    message: 'Category not found',
    status: HttpStatus.NOT_FOUND,
  },
  NEGATIVE_PRICE: {
    code: 'CAT-006',
    message: 'Price cannot be negative',
    status: HttpStatus.BAD_REQUEST,
  },
  INVALID_SKU_PRICE: {
    code: 'CAT-007',
    message: 'Cannot publish product with 0 or negative price SKU',
    status: HttpStatus.BAD_REQUEST,
  },
  CATEGORY_MOVE_TO_ITSELF: {
    code: 'CAT-008',
    message: 'Cannot move category to itself',
    status: HttpStatus.CONFLICT,
  },
  CATEGORY_MOVE_TO_DESCENDANT: {
    code: 'CAT-009',
    message: 'Cannot move category into its own descendant',
    status: HttpStatus.CONFLICT,
  },
  PRODUCT_NOT_FOUND: {
    code: 'CAT-010',
    message: 'Product not found',
    status: HttpStatus.NOT_FOUND,
  },
  CATEGORY_HAS_PRODUCTS: {
    code: 'CAT-011',
    message: 'Cannot delete category containing products',
    status: HttpStatus.CONFLICT,
  },
  SKU_NOT_FOUND: {
    code: 'CAT-012',
    message: 'SKU not found',
    status: HttpStatus.NOT_FOUND,
  },
  CATEGORY_HAS_CHILD_CATEGORIES: {
    code: 'CAT-013',
    message: 'Cannot delete category containing child categories',
    status: HttpStatus.CONFLICT,
  },
  CONCURRENCY_CONFLICT: {
    code: 'CAT-014',
    message: 'Product was modified by another request, please retry',
    status: HttpStatus.CONFLICT,
  },
  INVALID_SKU_ATTRIBUTES: {
    code: 'CAT-015',
    message: 'SKU attributes must be non-empty string key/value pairs',
    status: HttpStatus.BAD_REQUEST,
  },
};

export const UserErrorCodes = {
  DOMAIN_EXCEPTION: {
    code: 'USR-000',
    message: 'User domain exception',
    status: HttpStatus.BAD_REQUEST,
  },
  USER_NOT_FOUND: {
    code: 'USR-001',
    message: 'User not found',
    status: HttpStatus.NOT_FOUND,
  },
  EMAIL_ALREADY_EXISTS: {
    code: 'USR-002',
    message: 'Email already exists',
    status: HttpStatus.CONFLICT,
  },
};

export const AuthErrorCodes = {
  DOMAIN_EXCEPTION: {
    code: 'AUTH-000',
    message: 'Auth domain exception',
    status: HttpStatus.BAD_REQUEST,
  },
  INVALID_CREDENTIALS: {
    code: 'AUTH-001',
    message: 'Invalid email or password',
    status: HttpStatus.UNAUTHORIZED,
  },
  TOKEN_EXPIRED: {
    code: 'AUTH-002',
    message: 'Token has expired',
    status: HttpStatus.UNAUTHORIZED,
  },
  TOKEN_REVOKED: {
    code: 'AUTH-003',
    message: 'Token has been revoked',
    status: HttpStatus.UNAUTHORIZED,
  },
  UNAUTHORIZED_ACCESS: {
    code: 'AUTH-004',
    message: 'Unauthorized access',
    status: HttpStatus.UNAUTHORIZED,
  },
  FORBIDDEN_RESOURCE: {
    code: 'AUTH-005',
    message: 'Forbidden resource',
    status: HttpStatus.FORBIDDEN,
  },
  RATE_LIMIT_EXCEEDED: {
    code: 'AUTH-006',
    message: 'Too many requests',
    status: HttpStatus.TOO_MANY_REQUESTS,
  },
};
