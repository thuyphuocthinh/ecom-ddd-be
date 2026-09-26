import { AggregateRoot, CatalogErrorCodes } from '@/core/index.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';
import { Sku, SkuProps } from './sku.entity.js';

export enum ProductStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

export interface ProductProps {
  categoryId: string;
  name: string;
  description?: string | null;
  thumbnail?: string | null;
  status: ProductStatus;
  skus: Sku[]; // Danh sách biến thể
}

export class Product extends AggregateRoot<ProductProps> {
  // SKU ids explicitly removed via removeSku() during this use case.
  // The repository deletes exactly these rows instead of diffing its DB
  // read against this in-memory snapshot, so a SKU concurrently added by
  // another request in between is never mistaken for one to delete.
  private _removedSkuIds: string[] = [];

  get removedSkuIds(): string[] {
    return [...this._removedSkuIds];
  }

  static create(
    props: Omit<ProductProps, 'status' | 'skus'>,
    id?: string,
  ): Product {
    const product = new Product(
      {
        ...props,
        status: ProductStatus.DRAFT, // Mặc định luôn là DRAFT
        skus: [],
      },
      id,
    );
    // Bắn Domain Event (nếu cần)
    return product;
  }

  get categoryId(): string {
    return this.props.categoryId;
  }
  get name(): string {
    return this.props.name;
  }
  get status(): ProductStatus {
    return this.props.status;
  }
  get skus(): Sku[] {
    return [...this.props.skus];
  }

  public addSku(props: Omit<SkuProps, 'productId'>, skuId?: string): Sku {
    // Check trùng lặp attributes
    const isDuplicate = this.props.skus.some((sku) =>
      sku.hasSameAttributes(props.attributes),
    );
    if (isDuplicate) {
      throw new CatalogDomainException(CatalogErrorCodes.SKU_DUPLICATED);
    }

    const newSku = Sku.create({ ...props, productId: this.id }, skuId);

    this.props.skus.push(newSku);
    this.updatedAt = new Date();

    return newSku;
  }

  public removeSku(skuId: string): void {
    const initialLength = this.props.skus.length;
    this.props.skus = this.props.skus.filter((sku) => sku.id !== skuId);

    if (this.props.skus.length === initialLength) {
      throw new CatalogDomainException(CatalogErrorCodes.SKU_NOT_FOUND);
    }

    this._removedSkuIds.push(skuId);
    this.updatedAt = new Date();
  }

  public updateSkuPrice(skuId: string, newPrice: number): void {
    const sku = this.props.skus.find((s) => s.id === skuId);
    if (!sku) {
      throw new CatalogDomainException(CatalogErrorCodes.SKU_NOT_FOUND);
    }

    sku.updatePrice(newPrice);
    this.updatedAt = new Date();
  }

  public publish(): void {
    if (this.props.skus.length === 0) {
      throw new CatalogDomainException(CatalogErrorCodes.INVALID_PUBLISH);
    }

    const hasInvalidPrice = this.props.skus.some((sku) => sku.price <= 0);
    if (hasInvalidPrice) {
      throw new CatalogDomainException(CatalogErrorCodes.INVALID_SKU_PRICE);
    }

    this.props.status = ProductStatus.PUBLISHED;
    this.updatedAt = new Date();
  }

  public unpublish(): void {
    if (this.props.status !== ProductStatus.PUBLISHED) {
      // Ignore if already not published
      return;
    }
    this.props.status = ProductStatus.DRAFT;
    this.updatedAt = new Date();
  }

  public updateDetails(
    name?: string,
    description?: string,
    thumbnail?: string,
  ): void {
    if (name) this.props.name = name;
    if (description !== undefined) this.props.description = description;
    if (thumbnail !== undefined) this.props.thumbnail = thumbnail;
    this.updatedAt = new Date();
  }
}
