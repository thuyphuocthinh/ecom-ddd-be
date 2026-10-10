import type {
  CartFlag,
  CartLine,
  CartLineView,
  CartView,
  SkuInfo,
} from '../cart-line.js';

// Money is compared and added in hundredths, as whole numbers, so 199000.50 x 3 has no rounding error
const cents = (amount: number) => Math.round(amount * 100);

// A line with any of these cannot be ordered as it is. (priceChanged does not stop it: the price
// shown is already the new one.)
const BLOCKING: ReadonlyArray<CartFlag> = [
  'unpublished',
  'outOfStock',
  'notEnoughStock',
];

/**
 * One cart line as the customer sees it now: the current price, the units that can be sold, and
 * the flags.
 *  - `sku` is undefined when the SKU is gone from the catalog; `available` is undefined when it
 *    was not asked for (a SKU that is no longer on sale) or has no number at all.
 *  - priceChanged: the price now is not the price when it was put in.
 *  - unpublished: the SKU is gone, or its product is no longer on sale. Nothing else is said about
 *    such a line (no price, no stock).
 *  - outOfStock: nothing left. notEnoughStock: some left, but fewer than in the cart.
 */
export function viewLine(
  line: CartLine,
  sku: SkuInfo | undefined,
  available: number | undefined,
): CartLineView {
  const base = {
    skuId: line.skuId,
    productId: sku?.productId ?? null,
    productName: sku?.productName ?? null,
    thumbnail: sku?.thumbnail ?? null,
    attributes: sku?.attributes ?? null,
    quantity: line.quantity,
    addedPrice: line.addedPrice,
  };

  if (!sku || !sku.published) {
    return {
      ...base,
      price: null,
      available: null,
      flags: ['unpublished'],
    };
  }

  const units = Math.max(0, available ?? 0);
  const flags: CartFlag[] = [];
  if (cents(sku.price) !== cents(line.addedPrice)) flags.push('priceChanged');
  if (units === 0) flags.push('outOfStock');
  else if (units < line.quantity) flags.push('notEnoughStock');

  return { ...base, price: sku.price, available: units, flags };
}

/** The totals of a whole cart; `items` keep the order they are given in. */
export function summarise(items: CartLineView[]): CartView {
  let subtotalCents = 0;
  let quantityCount = 0;
  for (const item of items) {
    quantityCount += item.quantity;
    const blocked = item.flags.some((flag) => BLOCKING.includes(flag));
    if (!blocked && item.price !== null) {
      subtotalCents += cents(item.price) * item.quantity;
    }
  }
  return {
    items,
    subtotal: subtotalCents / 100,
    lineCount: items.length,
    quantityCount,
  };
}
