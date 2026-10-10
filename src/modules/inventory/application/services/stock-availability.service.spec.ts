import { vi } from 'vitest';
import { StockAvailabilityService } from './stock-availability.service.js';
import type { StockRebuilder } from './stock-rebuilder.service.js';
import type { IAvailabilityStore } from '../../domain/index.js';

/**
 * `redisNumbers` is what Redis has now; `afterRebuild` is what it has after a rebuild. A SKU in
 * `noStockRow` has no row in Postgres: the rebuilder reports it and gives it no number.
 */
const setup = (
  redisNumbers: Record<string, number | null>,
  options: {
    afterRebuild?: Record<string, number>;
    noStockRow?: string[];
  } = {},
) => {
  let rebuilt = false;
  const peek = vi.fn(async (ids: string[]) => {
    const map = new Map<string, number | null>();
    for (const id of ids) {
      const live = redisNumbers[id] ?? null;
      map.set(
        id,
        live ?? (rebuilt ? (options.afterRebuild?.[id] ?? null) : null),
      );
    }
    return map;
  });
  const rebuild = vi.fn(async (ids: string[]) => {
    rebuilt = true;
    return ids.filter((id) => options.noStockRow?.includes(id));
  });
  const service = new StockAvailabilityService(
    { peek } as unknown as IAvailabilityStore,
    { rebuild } as unknown as StockRebuilder,
  );
  return { service, peek, rebuild };
};

describe('StockAvailabilityService (AC-24 inventory)', () => {
  it('reads all the numbers Redis has in one call and does not rebuild anything', async () => {
    const { service, peek, rebuild } = setup({ A: 5, B: 0, C: 12 });

    const result = await service.getAvailable(['A', 'B', 'C']);

    expect(Object.fromEntries(result)).toEqual({ A: 5, B: 0, C: 12 });
    expect(peek).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('rebuilds only the SKUs Redis lost, then reads them again', async () => {
    const { service, peek, rebuild } = setup(
      { A: 5, B: null },
      { afterRebuild: { B: 7 } },
    );

    const result = await service.getAvailable(['A', 'B']);

    expect(Object.fromEntries(result)).toEqual({ A: 5, B: 7 });
    expect(rebuild).toHaveBeenCalledWith(['B']);
    expect(peek).toHaveBeenCalledTimes(2);
    expect(peek.mock.calls[1][0]).toEqual(['B']);
  });

  it('counts a SKU without a stock row as 0 and does not read it again', async () => {
    const { service, peek } = setup({ A: null }, { noStockRow: ['A'] });

    const result = await service.getAvailable(['A']);

    expect(result.get('A')).toBe(0);
    // the second read is only for SKUs that were rebuilt, and there are none
    expect(peek.mock.calls[1][0]).toEqual([]);
  });

  it('counts a SKU as sold out when it still has no number after the rebuild', async () => {
    const { service } = setup({ A: null });

    expect((await service.getAvailable(['A'])).get('A')).toBe(0);
  });

  it('never returns a negative number', async () => {
    const { service } = setup({ A: -4 });

    expect((await service.getAvailable(['A'])).get('A')).toBe(0);
  });

  it('answers every SKU asked about, each once, even when repeated', async () => {
    const { service, peek } = setup({ A: 1, B: 2 });

    const result = await service.getAvailable(['A', 'B', 'A']);

    expect(result.size).toBe(2);
    expect(peek.mock.calls[0][0]).toEqual(['A', 'B']);
  });

  it('answers an empty list without calling Redis', async () => {
    const { service, peek, rebuild } = setup({});

    expect((await service.getAvailable([])).size).toBe(0);
    expect(peek).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('lets a Redis failure through unchanged (INV-007 from the store)', async () => {
    const failure = Object.assign(new Error('down'), { code: 'INV-007' });
    const service = new StockAvailabilityService(
      {
        peek: async () => {
          throw failure;
        },
      } as unknown as IAvailabilityStore,
      { rebuild: vi.fn() } as unknown as StockRebuilder,
    );

    await expect(service.getAvailable(['A'])).rejects.toBe(failure);
  });
});
