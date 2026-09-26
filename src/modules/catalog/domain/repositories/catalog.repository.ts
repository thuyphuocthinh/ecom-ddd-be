import { Product } from '../entities/product.entity.js';
import { Category } from '../entities/category.entity.js';
import { PaginatedResult } from '@/core/index.js';
import { ProductStatus } from '../entities/product.entity.js';

export interface FindProductsParams {
  limit: number;
  cursor?: string;
  categoryId?: string;
  search?: string;
  status?: ProductStatus;
  minPrice?: number;
  maxPrice?: number;
}

export interface IProductRepository {
  findById(id: string): Promise<Product | null>;
  save(product: Product): Promise<void>;

  // For Keyset pagination
  findList(params: FindProductsParams): Promise<PaginatedResult<Product>>;
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
