import { Entity } from '@/core/index.js';
import { Price } from '../value-objects/price.vo.js';
import { SkuAttributes } from '../value-objects/sku-attributes.vo.js';

export interface SkuProps {
  productId: string;
  price: Price;
  attributes: SkuAttributes;
  skuCode: string;
  barcode?: string | null;
}

export class Sku extends Entity<SkuProps> {
  static create(props: SkuProps, id?: string): Sku {
    return new Sku(props, id);
  }

  get productId(): string {
    return this.props.productId;
  }
  get price(): Price {
    return this.props.price;
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

  updatePrice(newPrice: Price): void {
    this.props.price = newPrice;
    this.updatedAt = new Date();
  }

  // Helper to check if this SKU has exactly the same attributes as another
  hasSameAttributes(otherAttributes: SkuAttributes): boolean {
    return this.props.attributes.equals(otherAttributes);
  }
}
