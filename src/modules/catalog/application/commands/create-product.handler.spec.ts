import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreateProductHandler } from './create-product.handler.js';
import { CreateProductCommand } from './create-product.command.js';
import { CatalogDomainException } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';
import { Category } from '../../domain/index.js';

describe('CreateProductHandler', () => {
  let handler: CreateProductHandler;
  let mockProductRepo: any;
  let mockCategoryRepo: any;

  beforeEach(() => {
    mockProductRepo = {
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockCategoryRepo = {
      findById: vi.fn(),
    };

    handler = new CreateProductHandler(mockProductRepo, mockCategoryRepo);
  });

  it('should throw exception if category not found', async () => {
    mockCategoryRepo.findById.mockResolvedValue(null);

    const command = new CreateProductCommand('cat_invalid', 'Test Product');

    await expect(handler.execute(command)).rejects.toThrowError(
      new CatalogDomainException(
        CatalogErrorCodes.CATEGORY_NOT_FOUND,
        `Category with ID cat_invalid not found`,
      ),
    );
  });

  it('should create product and call repository save', async () => {
    const mockCategory = Category.create('Test Category', null, 'cat_1');
    mockCategoryRepo.findById.mockResolvedValue(mockCategory);

    const command = new CreateProductCommand(
      'cat_1',
      'Test Product',
      'Desc',
      'thumb.jpg',
      [{ price: 100000, attributes: { size: 'L' }, skuCode: 'TEST-L' }],
    );

    const product = await handler.execute(command);

    expect(product.categoryId).toBe('cat_1');
    expect(product.name).toBe('Test Product');
    expect(product.skus.length).toBe(1);
    expect(mockProductRepo.save).toHaveBeenCalledTimes(1);
    expect(mockProductRepo.save).toHaveBeenCalledWith(product);
  });
});
