import { describe, it, expect } from 'vitest';
import { Category } from './category.entity.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';
import { CatalogErrorCodes } from '@/core/index.js';

describe('Category Entity', () => {
  it('should create a root category', () => {
    const category = Category.create('Thời trang', null, 'cat_root');
    expect(category.parentId).toBeNull();
    expect(category.path).toBe('/cat_root/');
  });

  it('should create a child category with correct path', () => {
    const parent = Category.create('Thời trang', null, 'cat_root');
    const child = Category.create('Áo thun', parent, 'cat_child');

    expect(child.parentId).toBe('cat_root');
    expect(child.path).toBe('/cat_root/cat_child/');
  });

  it('should throw exception when creating category exceeding max depth', () => {
    const c1 = Category.create('C1', null, 'c1');
    const c2 = Category.create('C2', c1, 'c2');
    const c3 = Category.create('C3', c2, 'c3');
    const c4 = Category.create('C4', c3, 'c4');
    expect(() => {
      Category.create('C5', c4, 'c5');
    }).toThrowError(
      new CatalogDomainException(CatalogErrorCodes.MAX_DEPTH_EXCEEDED),
    );
  });

  it('should not allow moving category to itself', () => {
    const category = Category.create('Self', null, 'self_id');
    expect(() => {
      category.moveTo(category);
    }).toThrowError(
      new CatalogDomainException(CatalogErrorCodes.CATEGORY_MOVE_TO_ITSELF),
    );
  });

  it('should not allow moving category to its own descendant', () => {
    const parent = Category.create('Parent', null, 'parent_id');
    const child = Category.create('Child', parent, 'child_id');

    expect(() => {
      parent.moveTo(child);
    }).toThrowError(
      new CatalogDomainException(CatalogErrorCodes.CATEGORY_MOVE_TO_DESCENDANT),
    );
  });
});
