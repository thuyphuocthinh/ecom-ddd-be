/** What the cart remembers about one item. Everything else is looked up again at every view. */
export interface CartLine {
  skuId: string;
  quantity: number;
  /** The price when the item was put in (or its quantity last set): what the customer saw. */
  addedPrice: number;
  /** When the item was first put in, in milliseconds (Redis clock). Newest first in the view. */
  addedAt: number;
}

export type CartFlag =
  'priceChanged' | 'unpublished' | 'outOfStock' | 'notEnoughStock';

/** What the cart needs to know about a SKU (the catalog's answer, in the shape the cart uses). */
export interface SkuInfo {
  productId: string;
  productName: string;
  thumbnail: string | null;
  attributes: Record<string, string>;
  price: number;
  /** Whether the product is still on sale */
  published: boolean;
}

export interface CartLineView {
  skuId: string;
  productId: string | null;
  productName: string | null;
  thumbnail: string | null;
  attributes: Record<string, string> | null;
  quantity: number;
  /** The price now; null when the item is no longer on sale */
  price: number | null;
  addedPrice: number;
  /** Units that can be sold now; null when the item is no longer on sale */
  available: number | null;
  flags: CartFlag[];
}

export interface CartView {
  items: CartLineView[];
  /** The total of the lines that can be ordered as they are */
  subtotal: number;
  lineCount: number;
  quantityCount: number;
}
