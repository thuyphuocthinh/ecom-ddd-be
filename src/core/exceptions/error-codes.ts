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

export const CatalogErrorCodes = {
  DOMAIN_EXCEPTION: { code: 'CAT-000', message: 'Catalog domain exception' },
  MAX_DEPTH_EXCEEDED: {
    code: 'CAT-001',
    message: 'Max category depth exceeded',
  },
  SKU_DUPLICATED: {
    code: 'CAT-002',
    message: 'SKU attributes already exist in this product',
  },
  INVALID_PUBLISH: {
    code: 'CAT-003',
    message: 'Cannot publish product without SKUs',
  },
  CATEGORY_HAS_CHILDREN: {
    code: 'CAT-004',
    message: 'Cannot add product to a category that has children',
  },
  CATEGORY_NOT_FOUND: { code: 'CAT-005', message: 'Category not found' },
  NEGATIVE_PRICE: { code: 'CAT-006', message: 'Price cannot be negative' },
  INVALID_SKU_PRICE: {
    code: 'CAT-007',
    message: 'Cannot publish product with 0 or negative price SKU',
  },
  CATEGORY_MOVE_TO_ITSELF: {
    code: 'CAT-008',
    message: 'Cannot move category to itself',
  },
  CATEGORY_MOVE_TO_DESCENDANT: {
    code: 'CAT-009',
    message: 'Cannot move category into its own descendant',
  },
  PRODUCT_NOT_FOUND: { code: 'CAT-010', message: 'Product not found' },
  CATEGORY_HAS_PRODUCTS: {
    code: 'CAT-011',
    message: 'Cannot delete category containing products',
  },
};
