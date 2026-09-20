import { Product } from '../entities/product.entity.js';
import { Category } from '../entities/category.entity.js';
import { PaginatedResult } from '@/core/index.js';

export interface IProductRepository {
  findById(id: string): Promise<Product | null>;
  save(product: Product): Promise<void>;

  // For Keyset pagination
  findList(
    cursor?: string,
    limit?: number,
    categoryId?: string,
  ): Promise<PaginatedResult<Product>>;
}

export interface ICategoryRepository {
  findById(id: string): Promise<Category | null>;
  save(category: Category): Promise<void>;
  findByParentId(parentId: string | null): Promise<Category[]>;

  // Bulk update category paths when moving a category
  updatePathAndChildren(category: Category, oldPath: string): Promise<void>;

  // Check if category has any products (useful before deletion)
  hasProducts(id: string): Promise<boolean>;

  // Delete a category
  delete(id: string): Promise<void>;
}
