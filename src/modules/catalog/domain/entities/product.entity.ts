import {
  AggregateRoot,
  CatalogErrorCodes,
  StringUtil,
  snowflake,
} from '@/core/index.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';
import { Sku, SkuProps } from './sku.entity.js';
import { Price } from '../value-objects/price.vo.js';

export enum ProductStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

export interface ProductProps {
  categoryId: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  thumbnail?: string | null;
  status: ProductStatus;
  skus: Sku[]; // Danh sách biến thể
  // Optimistic concurrency token. Mutating methods below don't bump this —
  // the repository increments it on a successful save, so it always
  // reflects the row version this in-memory instance was loaded from.
  version: number;
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
    props: Omit<ProductProps, 'status' | 'skus' | 'version'>,
    id?: string,
  ): Product {
    const productId = id || snowflake.nextId();
    const slug =
      props.slug || (props.name ? `${StringUtil.slugify(props.name)}` : null);

    const product = new Product(
      {
        ...props,
        slug,
        status: ProductStatus.DRAFT, // Mặc định luôn là DRAFT
        skus: [],
        version: 1,
      },
      productId,
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
  get slug(): string | null {
    return this.props.slug ?? null;
  }
  get status(): ProductStatus {
    return this.props.status;
  }
  get skus(): Sku[] {
    return [...this.props.skus];
  }
  get version(): number {
    return this.props.version;
  }

  /** The lowest selling price among the SKUs, or null when there is none. */
  get minPrice(): number | null {
    if (this.props.skus.length === 0) return null;
    return Math.min(...this.props.skus.map((sku) => sku.price.amount));
  }
  /** Whether any SKU is sold below its original price. */
  get onSale(): boolean {
    return this.props.skus.some((sku) => sku.compareAtPrice !== null);
  }
  /** The biggest discount among the SKUs, in whole percent (0 when none is discounted). */
  get discountPercent(): number {
    return Math.max(0, ...this.props.skus.map((sku) => sku.discountPercent));
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

  /** `compareAtPrice`: a price sets the original price, `null` removes it, leaving it out keeps it. */
  public updateSkuPrice(
    skuId: string,
    newPrice: Price,
    compareAtPrice?: Price | null,
  ): void {
    const sku = this.props.skus.find((s) => s.id === skuId);
    if (!sku) {
      throw new CatalogDomainException(CatalogErrorCodes.SKU_NOT_FOUND);
    }

    sku.updatePrice(newPrice, compareAtPrice);
    this.updatedAt = new Date();
  }

  public publish(): void {
    if (this.props.skus.length === 0) {
      throw new CatalogDomainException(CatalogErrorCodes.INVALID_PUBLISH);
    }

    const hasInvalidPrice = this.props.skus.some(
      (sku) => sku.price.amount <= 0,
    );
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
    slug?: string | null,
  ): void {
    if (name) {
      this.props.name = name;
      if (slug === undefined && !this.props.slug) {
        this.props.slug = StringUtil.slugify(name);
      }
    }
    if (slug !== undefined) this.props.slug = slug;
    if (description !== undefined) this.props.description = description;
    if (thumbnail !== undefined) this.props.thumbnail = thumbnail;
    this.updatedAt = new Date();
  }
}
