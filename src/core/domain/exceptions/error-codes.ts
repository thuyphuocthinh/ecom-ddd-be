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
  RESOURCE_BUSY: {
    code: 'SYS-002',
    message: 'Another request is changing this right now, please try again',
    status: HttpStatus.CONFLICT,
  },
};

export const StorageErrorCodes = {
  NOT_CONFIGURED: {
    code: 'STO-001',
    message: 'Image upload is not available right now',
    status: HttpStatus.SERVICE_UNAVAILABLE,
  },
  UNAVAILABLE: {
    code: 'STO-002',
    message: 'The image could not be saved, please try again later',
    status: HttpStatus.SERVICE_UNAVAILABLE,
  },
  UNREADABLE_IMAGE: {
    code: 'STO-003',
    message: 'The file could not be read as an image',
    status: HttpStatus.BAD_REQUEST,
  },
};

export const OrderErrorCodes = {
  DOMAIN_EXCEPTION: {
    code: 'ORD-000',
    message: 'Order domain exception',
    status: HttpStatus.BAD_REQUEST,
  },
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
  EMPTY_CART: {
    code: 'ORD-003',
    message: 'Your cart is empty',
    status: HttpStatus.CONFLICT,
  },
  ITEM_UNAVAILABLE: {
    code: 'ORD-004',
    message: 'Some items in your cart are no longer on sale',
    status: HttpStatus.CONFLICT,
  },
  INVALID_IDEMPOTENCY_KEY: {
    code: 'ORD-005',
    message:
      'The Idempotency-Key header is required: 8 to 100 characters from A-Z a-z 0-9 _ -',
    status: HttpStatus.BAD_REQUEST,
  },
  INVALID_STATE_TRANSITION: {
    code: 'ORD-006',
    message: 'The order cannot move to that status from where it is now',
    status: HttpStatus.CONFLICT,
  },
};

export const PaymentErrorCodes = {
  DOMAIN_EXCEPTION: {
    code: 'PAY-000',
    message: 'Payment domain exception',
    status: HttpStatus.BAD_REQUEST,
  },
  INVALID_IDEMPOTENCY_KEY: {
    code: 'PAY-001',
    message:
      'The Idempotency-Key header is required: 8 to 100 characters from A-Z a-z 0-9 _ -',
    status: HttpStatus.BAD_REQUEST,
  },
  NOT_ONLINE: {
    code: 'PAY-002',
    message: 'Only an order paid online can be paid here',
    status: HttpStatus.CONFLICT,
  },
  NOT_PAYABLE: {
    code: 'PAY-003',
    message:
      'The order cannot be paid right now: it is not waiting for payment, or a payment is already in progress',
    status: HttpStatus.CONFLICT,
  },
  TOO_MANY_ATTEMPTS: {
    code: 'PAY-004',
    message: 'This order has used up its payment attempts',
    status: HttpStatus.CONFLICT,
  },
  TIME_RAN_OUT: {
    code: 'PAY-005',
    message:
      'The time to pay this order has run out, or its stock is no longer held; place a new order',
    status: HttpStatus.CONFLICT,
  },
  GATEWAY_UNAVAILABLE: {
    code: 'PAY-006',
    message:
      'The payment service is temporarily unavailable, please try again later',
    status: HttpStatus.SERVICE_UNAVAILABLE,
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
  SKU_HAS_RESERVATIONS: {
    code: 'CAT-016',
    message:
      'SKU has stock reservations and cannot be removed; unpublish the product instead',
    status: HttpStatus.CONFLICT,
  },
  INVALID_SEARCH_REQUEST: {
    code: 'CAT-017',
    message: 'This combination of search options cannot be answered',
    status: HttpStatus.BAD_REQUEST,
  },
  INVALID_COMPARE_AT_PRICE: {
    code: 'CAT-018',
    message: 'The original price must be greater than the selling price',
    status: HttpStatus.BAD_REQUEST,
  },
};

export const InventoryErrorCodes = {
  OUT_OF_STOCK: {
    code: 'INV-001',
    message: 'Not enough stock available',
    status: HttpStatus.CONFLICT,
  },
  INVALID_RESERVATION_REQUEST: {
    code: 'INV-002',
    message: 'Invalid reservation request',
    status: HttpStatus.BAD_REQUEST,
  },
  RESERVATION_NOT_FOUND: {
    code: 'INV-003',
    message: 'No stock is held for this order',
    status: HttpStatus.NOT_FOUND,
  },
  RESERVATION_IN_PROGRESS: {
    code: 'INV-004',
    message: 'This order is being processed right now, please try again',
    status: HttpStatus.CONFLICT,
  },
  RESERVATION_CONFLICT: {
    code: 'INV-005',
    message: 'This order already holds stock with different content',
    status: HttpStatus.CONFLICT,
  },
  RESERVATION_RELEASED: {
    code: 'INV-006',
    message:
      'The stock held for this order was already returned; create a new order',
    status: HttpStatus.CONFLICT,
  },
  RESERVATION_NOT_CONFIRMED: {
    code: 'INV-008',
    message:
      'The stock of this order was not taken out of the warehouse, so there is nothing to put back',
    status: HttpStatus.CONFLICT,
  },
  EXTEND_NOT_ALLOWED: {
    code: 'INV-009',
    message:
      'The stock held for this order cannot be held for longer: it was returned, paid, or has already expired',
    status: HttpStatus.CONFLICT,
  },
  STOCK_UNAVAILABLE: {
    code: 'INV-007',
    message: 'Stock service is temporarily unavailable, please try again later',
    status: HttpStatus.SERVICE_UNAVAILABLE,
  },
};

export const LocationErrorCodes = {
  PROVINCE_NOT_FOUND: {
    code: 'LOC-001',
    message: 'Province not found',
    status: HttpStatus.NOT_FOUND,
  },
  WARD_NOT_FOUND: {
    code: 'LOC-002',
    message: 'Ward not found',
    status: HttpStatus.NOT_FOUND,
  },
};

export const CartErrorCodes = {
  DOMAIN_EXCEPTION: {
    code: 'CART-000',
    message: 'Cart domain exception',
    status: HttpStatus.BAD_REQUEST,
  },
  CART_FULL: {
    code: 'CART-001',
    message: 'The cart can hold at most 50 different items',
    status: HttpStatus.CONFLICT,
  },
  QUANTITY_LIMIT: {
    code: 'CART-002',
    message: 'You can have at most 99 of one item in the cart',
    status: HttpStatus.CONFLICT,
  },
  ITEM_NOT_AVAILABLE: {
    code: 'CART-003',
    message: 'This item is not available',
    status: HttpStatus.NOT_FOUND,
  },
  ITEM_NOT_IN_CART: {
    code: 'CART-004',
    message: 'This item is not in the cart',
    status: HttpStatus.NOT_FOUND,
  },
  CART_UNAVAILABLE: {
    code: 'CART-005',
    message: 'The cart is temporarily unavailable, please try again later',
    status: HttpStatus.SERVICE_UNAVAILABLE,
  },
};

export const AddressErrorCodes = {
  DOMAIN_EXCEPTION: {
    code: 'ADDR-000',
    message: 'Address domain exception',
    status: HttpStatus.BAD_REQUEST,
  },
  ADDRESS_NOT_FOUND: {
    code: 'ADDR-001',
    message: 'Address not found',
    status: HttpStatus.NOT_FOUND,
  },
  ADDRESS_LIMIT_REACHED: {
    code: 'ADDR-002',
    message: 'You can keep at most 10 addresses',
    status: HttpStatus.CONFLICT,
  },
  INVALID_ADDRESS: {
    code: 'ADDR-003',
    message: 'The address is not valid',
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
  INVALID_AVATAR: {
    code: 'USR-003',
    message: 'The avatar must be a JPEG, PNG or WebP image of at most 2 MB',
    status: HttpStatus.BAD_REQUEST,
  },
  INVALID_DISPLAY_NAME: {
    code: 'USR-006',
    message: 'The display name must contain 1 to 100 visible characters',
    status: HttpStatus.BAD_REQUEST,
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
  SESSION_NOT_FOUND: {
    code: 'AUTH-007',
    message: 'Session not found',
    status: HttpStatus.NOT_FOUND,
  },
  // One answer for a wrong, expired, used-up or never-issued code, so the reply says nothing about which
  INVALID_VERIFICATION_CODE: {
    code: 'AUTH-008',
    message: 'Invalid or expired verification code',
    status: HttpStatus.BAD_REQUEST,
  },
  // Asking for a new code when nothing is waiting (never registered, already has an account, or it timed out)
  NO_PENDING_REGISTRATION: {
    code: 'AUTH-009',
    message: 'No registration is waiting for this email; register again',
    status: HttpStatus.NOT_FOUND,
  },
  // Only when choosing a password (register); login never applies it. `errors.reason` says which rule
  WEAK_PASSWORD: {
    code: 'AUTH-010',
    message: 'Password is too easy to guess',
    status: HttpStatus.BAD_REQUEST,
  },
  // Sign in with Google: the ID token is not acceptable (bad signature, wrong issuer or audience,
  // expired, too old, already used, wrong nonce). One answer for all of them.
  INVALID_GOOGLE_TOKEN: {
    code: 'AUTH-014',
    message: 'Invalid Google sign-in token',
    status: HttpStatus.UNAUTHORIZED,
  },
  GOOGLE_EMAIL_NOT_VERIFIED: {
    code: 'AUTH-015',
    message: 'The email of this Google account is not verified',
    status: HttpStatus.FORBIDDEN,
  },
  // The account already has a different Google account linked, or this Google account belongs to
  // someone else
  GOOGLE_ACCOUNT_CONFLICT: {
    code: 'AUTH-016',
    message: 'This account is linked to a different Google account',
    status: HttpStatus.CONFLICT,
  },
  LAST_LOGIN_METHOD: {
    code: 'AUTH-017',
    message:
      'Google is the only way to log in to this account; it cannot be removed',
    status: HttpStatus.BAD_REQUEST,
  },
  GOOGLE_NOT_CONFIGURED: {
    code: 'AUTH-018',
    message: 'Sign in with Google is not enabled',
    status: HttpStatus.SERVICE_UNAVAILABLE,
  },
  GOOGLE_NOT_LINKED: {
    code: 'AUTH-019',
    message: 'No Google account is linked to this account',
    status: HttpStatus.NOT_FOUND,
  },
  // The person proved who they are, but the account is suspended
  ACCOUNT_SUSPENDED: {
    code: 'AUTH-020',
    message: 'This account has been suspended. Please contact support.',
    status: HttpStatus.FORBIDDEN,
  },
  // Administrators cannot be suspended (lower the role first)
  ADMIN_CANNOT_BE_SUSPENDED: {
    code: 'AUTH-021',
    message: 'An administrator cannot be suspended',
    status: HttpStatus.FORBIDDEN,
  },
  // change-password: the current password the user typed is wrong
  INCORRECT_CURRENT_PASSWORD: {
    code: 'AUTH-012',
    message: 'The current password is incorrect',
    status: HttpStatus.BAD_REQUEST,
  },
  // change-password: someone else changed the password between the check and the write
  PASSWORD_CHANGED_CONCURRENTLY: {
    code: 'AUTH-013',
    message: 'The password was changed by another request; try again',
    status: HttpStatus.CONFLICT,
  },
  // verify-email: the code is right but the password differs from the one the waiting registration was
  // made with, e.g. someone else registered this address meanwhile. Only the mailbox owner gets this far.
  REGISTRATION_PASSWORD_MISMATCH: {
    code: 'AUTH-011',
    message:
      'Password does not match the registration this code belongs to; register again',
    status: HttpStatus.BAD_REQUEST,
  },
};
