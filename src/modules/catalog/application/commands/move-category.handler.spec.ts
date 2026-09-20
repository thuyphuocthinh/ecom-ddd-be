import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MoveCategoryHandler } from './move-category.handler.js';
import { MoveCategoryCommand } from './move-category.command.js';
import { Category, CatalogDomainException } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

describe('MoveCategoryHandler', () => {
  let handler: MoveCategoryHandler;
  let categoryRepo: any;

  beforeEach(() => {
    categoryRepo = {
      findById: vi.fn(),
      updatePathAndChildren: vi.fn(),
    };
    handler = new MoveCategoryHandler(categoryRepo);
  });

  it('should move category successfully to a new parent', async () => {
    const root1 = Category.create('Root 1', null, 'cat_root1');
    const root2 = Category.create('Root 2', null, 'cat_root2');
    const child = Category.create('Child', root1, 'cat_child');
    const oldPath = child.path;

    categoryRepo.findById.mockImplementation((id: string) => {
      if (id === 'cat_child') return Promise.resolve(child);
      if (id === 'cat_root2') return Promise.resolve(root2);
      return Promise.resolve(null);
    });

    categoryRepo.updatePathAndChildren.mockResolvedValue(undefined);

    const command = new MoveCategoryCommand('cat_child', 'cat_root2');
    const updatedCategory = await handler.execute(command);

    expect(updatedCategory.parentId).toBe('cat_root2');
    expect(updatedCategory.path).toBe('/cat_root2/cat_child/');
    expect(categoryRepo.updatePathAndChildren).toHaveBeenCalledWith(
      updatedCategory,
      oldPath,
    );
  });

  it('should throw exception if target category not found', async () => {
    categoryRepo.findById.mockResolvedValue(null);

    const command = new MoveCategoryCommand('cat_invalid', 'cat_root2');
    await expect(handler.execute(command)).rejects.toThrow(
      CatalogDomainException,
    );
    await expect(handler.execute(command)).rejects.toMatchObject({
      code: CatalogErrorCodes.CATEGORY_NOT_FOUND.code,
    });
  });

  it('should throw exception if new parent category not found', async () => {
    const child = Category.create('Child', null, 'cat_child');

    categoryRepo.findById.mockImplementation((id: string) => {
      if (id === 'cat_child') return Promise.resolve(child);
      return Promise.resolve(null);
    });

    const command = new MoveCategoryCommand('cat_child', 'cat_invalid_parent');
    await expect(handler.execute(command)).rejects.toThrow(
      CatalogDomainException,
    );
    await expect(handler.execute(command)).rejects.toMatchObject({
      code: CatalogErrorCodes.CATEGORY_NOT_FOUND.code,
    });
  });
});
