import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CreateCategoryHandler } from './create-category.handler.js';
import { CreateCategoryCommand } from './create-category.command.js';
import { Category, CatalogDomainException } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

describe('CreateCategoryHandler', () => {
  let handler: CreateCategoryHandler;
  let categoryRepo: any;

  beforeEach(() => {
    categoryRepo = {
      findById: vi.fn(),
      save: vi.fn(),
    };
    handler = new CreateCategoryHandler(categoryRepo);
  });

  it('should create a root category if parentId is not provided', async () => {
    const command = new CreateCategoryCommand('Electronics');

    categoryRepo.save.mockResolvedValueOnce(undefined);

    const category = await handler.execute(command);

    expect(category).toBeInstanceOf(Category);
    expect(category.getProps().name).toBe('Electronics');
    expect(category.getProps().path).toBe(`/${category.id}/`);
    expect(categoryRepo.save).toHaveBeenCalledWith(category);
  });

  it('should create a child category if parentId is valid', async () => {
    const parentCategory = Category.create('Electronics', null, 'parent_id');
    categoryRepo.findById.mockResolvedValueOnce(parentCategory);
    categoryRepo.save.mockResolvedValueOnce(undefined);

    const command = new CreateCategoryCommand('Laptops', 'parent_id');
    const category = await handler.execute(command);

    expect(category).toBeInstanceOf(Category);
    expect(category.getProps().name).toBe('Laptops');
    expect(category.getProps().path).toBe(`/parent_id/${category.id}/`);
    expect(categoryRepo.findById).toHaveBeenCalledWith('parent_id');
    expect(categoryRepo.save).toHaveBeenCalledWith(category);
  });

  it('should throw CatalogDomainException if parent category is not found', async () => {
    categoryRepo.findById.mockResolvedValue(null);

    const command = new CreateCategoryCommand('Laptops', 'invalid_parent_id');

    await expect(handler.execute(command)).rejects.toThrow(
      CatalogDomainException,
    );
    await expect(handler.execute(command)).rejects.toMatchObject({
      code: CatalogErrorCodes.CATEGORY_NOT_FOUND.code,
    });
  });

  it('should throw CatalogDomainException if max depth is reached', async () => {
    const parentCategory = {
      id: '5',
      path: '/1/2/3/4/5/',
    } as unknown as Category;
    categoryRepo.findById.mockResolvedValue(parentCategory);

    const command = new CreateCategoryCommand('Laptops', '5');

    await expect(handler.execute(command)).rejects.toThrow(
      CatalogDomainException,
    );
    await expect(handler.execute(command)).rejects.toMatchObject({
      code: CatalogErrorCodes.MAX_DEPTH_EXCEEDED.code,
    });
  });
});
