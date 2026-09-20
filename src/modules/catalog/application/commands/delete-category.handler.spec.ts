import { vi, describe, it, expect, beforeEach } from 'vitest';
import { DeleteCategoryHandler } from './delete-category.handler.js';
import { DeleteCategoryCommand } from './delete-category.command.js';
import { CatalogDomainException, Category } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

describe('DeleteCategoryHandler', () => {
  let handler: DeleteCategoryHandler;
  let categoryRepo: any;

  beforeEach(() => {
    categoryRepo = {
      findById: vi.fn(),
      hasProducts: vi.fn(),
      delete: vi.fn(),
    };
    handler = new DeleteCategoryHandler(categoryRepo);
  });

  it('should delete category successfully if it has no products', async () => {
    const category = Category.create('Electronics', null, 'cat_1');
    categoryRepo.findById.mockResolvedValue(category);
    categoryRepo.hasProducts.mockResolvedValue(false);
    categoryRepo.delete.mockResolvedValue(undefined);

    const command = new DeleteCategoryCommand('cat_1');
    await expect(handler.execute(command)).resolves.toBeUndefined();

    expect(categoryRepo.findById).toHaveBeenCalledWith('cat_1');
    expect(categoryRepo.hasProducts).toHaveBeenCalledWith('cat_1');
    expect(categoryRepo.delete).toHaveBeenCalledWith('cat_1');
  });

  it('should throw exception if category not found', async () => {
    categoryRepo.findById.mockResolvedValue(null);

    const command = new DeleteCategoryCommand('cat_invalid');
    await expect(handler.execute(command)).rejects.toThrow(
      CatalogDomainException,
    );
    await expect(handler.execute(command)).rejects.toMatchObject({
      code: CatalogErrorCodes.CATEGORY_NOT_FOUND.code,
    });
  });

  it('should throw exception if category has products', async () => {
    const category = Category.create('Electronics', null, 'cat_1');
    categoryRepo.findById.mockResolvedValue(category);
    categoryRepo.hasProducts.mockResolvedValue(true);

    const command = new DeleteCategoryCommand('cat_1');
    await expect(handler.execute(command)).rejects.toThrow(
      CatalogDomainException,
    );
    await expect(handler.execute(command)).rejects.toMatchObject({
      code: CatalogErrorCodes.CATEGORY_HAS_PRODUCTS.code,
    });

    expect(categoryRepo.delete).not.toHaveBeenCalled();
  });
});
