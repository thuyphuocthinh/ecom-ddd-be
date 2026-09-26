import { Entity, CatalogErrorCodes, snowflake } from '@/core/index.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';

export interface CategoryProps {
  parentId: string | null;
  name: string;
  path: string; // VD: /parent-id/this-id/
  isActive: boolean;
}

export class Category extends Entity<CategoryProps> {
  static readonly MAX_DEPTH = 5;

  static create(
    name: string,
    parentCategory: Category | null,
    id?: string,
  ): Category {
    const categoryId = id || snowflake.nextId();
    let path = `/${categoryId}/`;

    if (parentCategory) {
      // Tính toán độ sâu (đếm số dấu gạch chéo trừ đi 1)
      const depth = parentCategory.path.split('/').length - 1;
      if (depth >= Category.MAX_DEPTH) {
        throw new CatalogDomainException(CatalogErrorCodes.MAX_DEPTH_EXCEEDED);
      }
      path = `${parentCategory.path}${categoryId}/`;
    }

    return new Category(
      {
        parentId: parentCategory ? parentCategory.id : null,
        name,
        path,
        isActive: true,
      },
      categoryId,
    );
  }

  get name(): string {
    return this.props.name;
  }
  get path(): string {
    return this.props.path;
  }
  get parentId(): string | null {
    return this.props.parentId;
  }

  public moveTo(newParent: Category | null): void {
    if (newParent && newParent.id === this.id) {
      throw new CatalogDomainException(
        CatalogErrorCodes.CATEGORY_MOVE_TO_ITSELF,
      );
    }

    if (newParent) {
      // Kiểm tra xem parent mới có nằm trong chính cây con của mình không
      // Tránh lặp vòng tròn
      if (newParent.path.startsWith(this.path)) {
        throw new CatalogDomainException(
          CatalogErrorCodes.CATEGORY_MOVE_TO_DESCENDANT,
        );
      }

      const newDepth = newParent.path.split('/').length - 1;
      if (newDepth >= Category.MAX_DEPTH) {
        throw new CatalogDomainException(CatalogErrorCodes.MAX_DEPTH_EXCEEDED);
      }

      this.props.parentId = newParent.id;
      this.props.path = `${newParent.path}${this.id}/`;
    } else {
      this.props.parentId = null;
      this.props.path = `/${this.id}/`;
    }

    this.updatedAt = new Date();
  }
}
