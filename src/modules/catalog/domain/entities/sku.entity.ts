import { CatalogErrorCodes, Entity } from '@/core/index.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';
import { Price } from '../value-objects/price.vo.js';
import { SkuAttributes } from '../value-objects/sku-attributes.vo.js';

/**
 * The price before a discount must be greater than the selling price: a "discount" that is not
 * lower than what is charged is not one. Display only: only `price` is ever charged.
 */
function assertCompareAtPrice(
  price: Price,
  compareAtPrice: Price | null,
): void {
  if (compareAtPrice !== null && compareAtPrice.amount <= price.amount) {
    throw new CatalogDomainException(
      CatalogErrorCodes.INVALID_COMPARE_AT_PRICE,
    );
  }
}

export interface SkuProps {
  productId: string;
  price: Price;
  /** The price before a discount (shown crossed out), or null when the SKU is not discounted. */
  compareAtPrice?: Price | null;
  attributes: SkuAttributes;
  skuCode: string;
  barcode?: string | null;
}

export class Sku extends Entity<SkuProps> {
  static create(props: SkuProps, id?: string): Sku {
    const compareAtPrice = props.compareAtPrice ?? null;
    assertCompareAtPrice(props.price, compareAtPrice);
    return new Sku({ ...props, compareAtPrice }, id);
  }

  get productId(): string {
    return this.props.productId;
  }
  get price(): Price {
    return this.props.price;
  }
  get compareAtPrice(): Price | null {
    return this.props.compareAtPrice ?? null;
  }
  /** How much cheaper the selling price is than the original, in whole percent (0 when not discounted). */
  get discountPercent(): number {
    const original = this.compareAtPrice;
    if (original === null) return 0;
    const percent = Math.round(
      ((original.amount - this.props.price.amount) / original.amount) * 100,
    );
    return Math.max(1, percent);
  }
  get attributes(): SkuAttributes {
    return this.props.attributes;
  }
  get skuCode(): string {
    return this.props.skuCode;
  }
  get barcode(): string | null | undefined {
    return this.props.barcode;
  }

  /**
   * Sets the selling price and, with it, the price before the discount: a number sets it, `null`
   * removes the discount, and leaving it out keeps what is there. The result must still be a
   * discount (original greater than selling price), or nothing changes.
   */
  updatePrice(newPrice: Price, compareAtPrice?: Price | null): void {
    const nextCompareAtPrice =
      compareAtPrice === undefined ? this.compareAtPrice : compareAtPrice;
    assertCompareAtPrice(newPrice, nextCompareAtPrice);
    this.props.price = newPrice;
    this.props.compareAtPrice = nextCompareAtPrice;
    this.updatedAt = new Date();
  }

  // Helper to check if this SKU has exactly the same attributes as another
  hasSameAttributes(otherAttributes: SkuAttributes): boolean {
    return this.props.attributes.equals(otherAttributes);
  }
}
