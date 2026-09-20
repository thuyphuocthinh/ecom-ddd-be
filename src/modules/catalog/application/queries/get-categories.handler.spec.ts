import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GetCategoriesHandler } from './get-categories.handler.js';
import { GetCategoriesQuery } from './get-categories.query.js';
import { Category } from '../../domain/index.js';

describe('GetCategoriesHandler', () => {
  let handler: GetCategoriesHandler;
  let categoryRepo: any;

  beforeEach(() => {
    categoryRepo = {
      findByParentId: vi.fn(),
    };
    handler = new GetCategoriesHandler(categoryRepo);
  });

  it('should get root categories when parentId is not provided', async () => {
    const root1 = Category.create('Root 1', null, '1');
    const root2 = Category.create('Root 2', null, '2');
    categoryRepo.findByParentId.mockResolvedValueOnce([root1, root2]);

    const query = new GetCategoriesQuery();
    const result = await handler.execute(query);

    expect(result).toHaveLength(2);
    expect(result[0].getProps().name).toBe('Root 1');
    expect(categoryRepo.findByParentId).toHaveBeenCalledWith(null);
  });

  it('should get child categories when parentId is provided', async () => {
    const parent = Category.create('Parent', null, 'parent_id');
    const child1 = Category.create('Child 1', parent, 'child_1');

    categoryRepo.findByParentId.mockResolvedValueOnce([child1]);

    const query = new GetCategoriesQuery('parent_id');
    const result = await handler.execute(query);

    expect(result).toHaveLength(1);
    expect(result[0].getProps().name).toBe('Child 1');
    expect(categoryRepo.findByParentId).toHaveBeenCalledWith('parent_id');
  });
});
