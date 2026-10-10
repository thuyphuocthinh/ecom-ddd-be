import { Inject, Injectable } from '@nestjs/common';
import type { IProductRepository, SkuLookupItem } from '../../domain/index.js';

/**
 * Many SKUs at once, for other modules (the cart): price, product name, picture and whether the
 * product is still on sale, in one query however many SKUs are asked for.
 *
 * It is an internal reader, not an endpoint, so nothing here checks who is asking: the caller must
 * not show details of a product that is no longer on sale to anyone who should not see them.
 */
@Injectable()
export class SkuLookupService {
  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  /** The SKUs that exist, by id. A SKU that does not exist is not in the map. */
  async findMany(skuIds: string[]): Promise<Map<string, SkuLookupItem>> {
    const unique = [...new Set(skuIds)];
    if (unique.length === 0) return new Map();
    const items = await this.productRepo.findSkusByIds(unique);
    return new Map(items.map((item) => [item.skuId, item]));
  }
}
