import { Inject, Injectable } from '@nestjs/common';
import type { IAvailabilityStore } from '../../domain/index.js';
import { StockRebuilder } from './stock-rebuilder.service.js';

/**
 * How many units of many SKUs can be sold right now, for other modules (the cart). Read-only:
 * it takes nothing and holds nothing.
 *
 * The numbers Redis has are read in ONE call for all the SKUs. A SKU that Redis has no number for
 * (it lost it) is rebuilt from Postgres, the same way as when stock is held; a SKU with no stock
 * row at all counts as 0 and gets no number in Redis. Redis not answering is INV-007, as for every
 * other stock operation.
 */
@Injectable()
export class StockAvailabilityService {
  constructor(
    @Inject('IAvailabilityStore') private readonly store: IAvailabilityStore,
    private readonly rebuilder: StockRebuilder,
  ) {}

  /** A number (never below 0) for every SKU asked about. */
  async getAvailable(skuIds: string[]): Promise<Map<string, number>> {
    const available = new Map<string, number>();
    const unique = [...new Set(skuIds)];
    if (unique.length === 0) return available;

    const known = await this.store.peek(unique);
    const missing: string[] = [];
    for (const skuId of unique) {
      const units = known.get(skuId);
      if (units === null || units === undefined) missing.push(skuId);
      else available.set(skuId, Math.max(0, units));
    }
    if (missing.length === 0) return available;

    const withoutStock = new Set(await this.rebuilder.rebuild(missing));
    for (const skuId of withoutStock) available.set(skuId, 0);

    const rebuilt = missing.filter((skuId) => !withoutStock.has(skuId));
    const again = await this.store.peek(rebuilt);
    for (const skuId of rebuilt) {
      // Still no number (it vanished again at that very moment): count it as sold out, the safe side
      available.set(skuId, Math.max(0, again.get(skuId) ?? 0));
    }
    return available;
  }
}
