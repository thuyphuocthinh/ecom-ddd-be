import { vi } from 'vitest';
import { SkuLookupService } from './sku-lookup.service.js';
import type { IProductRepository, SkuLookupItem } from '../../domain/index.js';

const item = (skuId: string, overrides: Partial<SkuLookupItem> = {}) => ({
  skuId,
  productId: 'P1',
  productName: 'AirPods',
  thumbnail: null,
  attributes: {},
  price: 1000,
  published: true,
  ...overrides,
});

const serviceWith = (found: SkuLookupItem[]) => {
  const findSkusByIds = vi.fn(async () => found);
  const service = new SkuLookupService({
    findSkusByIds,
  } as unknown as IProductRepository);
  return { service, findSkusByIds };
};

describe('SkuLookupService', () => {
  it('gives a map by SKU id and asks the repository once', async () => {
    const { service, findSkusByIds } = serviceWith([item('A'), item('B')]);

    const result = await service.findMany(['A', 'B']);

    expect(findSkusByIds).toHaveBeenCalledTimes(1);
    expect([...result.keys()].sort()).toEqual(['A', 'B']);
    expect(result.get('A')?.price).toBe(1000);
  });

  it('asks about each SKU once even when it is repeated', async () => {
    const { service, findSkusByIds } = serviceWith([item('A')]);

    await service.findMany(['A', 'A', 'A']);

    expect(findSkusByIds).toHaveBeenCalledWith(['A']);
  });

  it('leaves out SKUs that do not exist', async () => {
    const { service } = serviceWith([item('A')]);

    const result = await service.findMany(['A', 'GONE']);

    expect(result.has('GONE')).toBe(false);
  });

  it('answers an empty list without a query', async () => {
    const { service, findSkusByIds } = serviceWith([]);

    expect((await service.findMany([])).size).toBe(0);
    expect(findSkusByIds).not.toHaveBeenCalled();
  });
});
