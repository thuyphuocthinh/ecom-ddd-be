import { Entity, CatalogErrorCodes } from '@/core/index.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';

export interface SkuProps {
  productId: string;
  price: number;
  attributes: Record<string, string>; // e.g., { color: 'Red', size: 'M' }
  skuCode: string;
  barcode?: string | null;
}

export class Sku extends Entity<SkuProps> {
  static create(props: SkuProps, id?: string): Sku {
    if (props.price < 0) {
      throw new CatalogDomainException(CatalogErrorCodes.NEGATIVE_PRICE);
    }
    return new Sku(props, id);
  }

  get productId(): string {
    return this.props.productId;
  }
  get price(): number {
    return this.props.price;
  }
  get attributes(): Record<string, string> {
    return this.props.attributes;
  }
  get skuCode(): string {
    return this.props.skuCode;
  }
  get barcode(): string | null | undefined {
    return this.props.barcode;
  }

  updatePrice(newPrice: number): void {
    if (newPrice < 0) {
      throw new CatalogDomainException(CatalogErrorCodes.NEGATIVE_PRICE);
    }
    this.props.price = newPrice;
    this.updatedAt = new Date();
  }

  // Helper function to check if this SKU has exactly the same attributes as another
  hasSameAttributes(otherAttributes: Record<string, string>): boolean {
    const keys1 = Object.keys(this.props.attributes);
    const keys2 = Object.keys(otherAttributes);

    if (keys1.length !== keys2.length) return false;

    for (const key of keys1) {
      if (this.props.attributes[key] !== otherAttributes[key]) {
        return false;
      }
    }
    return true;
  }
}
