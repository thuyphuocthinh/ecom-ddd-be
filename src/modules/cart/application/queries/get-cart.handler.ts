import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { SkuLookupService } from '../../../catalog/application/index.js';
import { StockAvailabilityService } from '../../../inventory/application/index.js';
import { GetCartQuery } from './get-cart.query.js';
import { summarise, viewLine } from '../../domain/index.js';
import type { CartView, ICartStore } from '../../domain/index.js';

/**
 * The cart as it is now. The cart itself only remembers the items, the quantities and the prices
 * seen; the price, whether it is still on sale and the stock are looked up again here, for all the
 * items at once (one question to the catalog, one to the stock), never item by item.
 */
@QueryHandler(GetCartQuery)
export class GetCartHandler implements IQueryHandler<GetCartQuery, CartView> {
  constructor(
    @Inject('ICartStore') private readonly store: ICartStore,
    private readonly skus: SkuLookupService,
    private readonly stock: StockAvailabilityService,
  ) {}

  async execute({ userId }: GetCartQuery): Promise<CartView> {
    const lines = await this.store.read(userId);
    if (lines.length === 0) return summarise([]);

    const skus = await this.skus.findMany(lines.map((line) => line.skuId));
    // Stock only for what can still be bought
    const onSale = lines
      .map((line) => line.skuId)
      .filter((skuId) => skus.get(skuId)?.published);
    const available = await this.stock.getAvailable(onSale);

    const items = lines
      .slice()
      .sort((a, b) => b.addedAt - a.addedAt || a.skuId.localeCompare(b.skuId))
      .map((line) =>
        viewLine(line, skus.get(line.skuId), available.get(line.skuId)),
      );
    return summarise(items);
  }
}
