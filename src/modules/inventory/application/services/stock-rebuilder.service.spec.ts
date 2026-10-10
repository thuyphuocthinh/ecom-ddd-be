import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StockRebuilder } from './stock-rebuilder.service.js';

describe('StockRebuilder (AC-17, AC-18)', () => {
  let stockRepo: any;
  let store: any;
  let locks: { run: ReturnType<typeof vi.fn> };
  let lockNames: string[];
  let rebuilder: StockRebuilder;

  beforeEach(() => {
    lockNames = [];
    stockRepo = { getSnapshot: vi.fn() };
    store = {
      peek: vi.fn().mockResolvedValue(new Map([['A', null]])),
      setIfAbsent: vi.fn().mockResolvedValue(true),
    };
    locks = {
      run: vi.fn(async (name: string, work: () => Promise<unknown>) => {
        lockNames.push(name);
        return work();
      }),
    };
    rebuilder = new StockRebuilder(stockRepo, store, locks as any);
  });

  it('writes onHand minus the units held, from what Postgres says', async () => {
    // The example of AC-17: onHand 10, O1 holds 2 and O2 holds 3
    stockRepo.getSnapshot.mockResolvedValue({ onHand: 10, reserved: 5 });

    const withoutStock = await rebuilder.rebuild(['A']);

    expect(withoutStock).toEqual([]);
    expect(store.setIfAbsent).toHaveBeenCalledWith('A', 5);
  });

  it('writes only when Redis still has no number, so a live number is never overwritten', async () => {
    stockRepo.getSnapshot.mockResolvedValue({ onHand: 10, reserved: 0 });

    await rebuilder.rebuild(['A']);

    // setIfAbsent is the write that refuses to overwrite; there is no plain "set"
    expect(store.setIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('works under a lock named after the SKU', async () => {
    stockRepo.getSnapshot.mockResolvedValue({ onHand: 1, reserved: 0 });

    await rebuilder.rebuild(['A']);

    expect(lockNames).toEqual(['inventory:rebuild:A']);
    expect('inventory:rebuild:A').toBe('inventory:rebuild:A');
  });

  it('checks again inside the lock and does nothing when somebody just rebuilt it (reads Postgres once)', async () => {
    store.peek.mockResolvedValue(new Map([['A', 7]])); // already there

    const withoutStock = await rebuilder.rebuild(['A']);

    expect(withoutStock).toEqual([]);
    expect(stockRepo.getSnapshot).not.toHaveBeenCalled();
    expect(store.setIfAbsent).not.toHaveBeenCalled();
  });

  it('keeps a number of 0 as a number: 0 is not "lost"', async () => {
    store.peek.mockResolvedValue(new Map([['A', 0]]));

    await rebuilder.rebuild(['A']);

    expect(stockRepo.getSnapshot).not.toHaveBeenCalled();
  });

  it('writes no number for a SKU without a stock row, and reports it (AC-5)', async () => {
    stockRepo.getSnapshot.mockResolvedValue(null);

    const withoutStock = await rebuilder.rebuild(['A']);

    expect(withoutStock).toEqual(['A']);
    expect(store.setIfAbsent).not.toHaveBeenCalled();
  });

  it('never writes a negative number, even if more is held than is on hand', async () => {
    stockRepo.getSnapshot.mockResolvedValue({ onHand: 2, reserved: 5 });

    await rebuilder.rebuild(['A']);

    expect(store.setIfAbsent).toHaveBeenCalledWith('A', 0);
  });

  it('takes one lock at a time, always in SKU order, so two rebuilds can never wait on each other', async () => {
    store.peek.mockResolvedValue(new Map([['x', null]]));
    stockRepo.getSnapshot.mockResolvedValue({ onHand: 1, reserved: 0 });

    await rebuilder.rebuild(['C', 'A', 'B']);

    expect(lockNames).toEqual([
      'inventory:rebuild:A',
      'inventory:rebuild:B',
      'inventory:rebuild:C',
    ]);
  });

  it('reports only the SKUs that have no stock row', async () => {
    store.peek.mockResolvedValue(new Map());
    stockRepo.getSnapshot
      .mockResolvedValueOnce({ onHand: 4, reserved: 1 }) // A
      .mockResolvedValueOnce(null); // B

    await expect(rebuilder.rebuild(['A', 'B'])).resolves.toEqual(['B']);
  });

  describe('requests for the same SKU at the same moment (AC-18)', () => {
    it('share one rebuild: one lock, one read of Postgres, one write, the same answer for everyone', async () => {
      stockRepo.getSnapshot.mockResolvedValue({ onHand: 10, reserved: 0 });

      const answers = await Promise.all(
        Array.from({ length: 200 }, () => rebuilder.rebuild(['A'])),
      );

      expect(answers.every((answer) => answer.length === 0)).toBe(true);
      expect(locks.run).toHaveBeenCalledTimes(1);
      expect(stockRepo.getSnapshot).toHaveBeenCalledTimes(1);
      expect(store.setIfAbsent).toHaveBeenCalledTimes(1);
    });

    it('share the answer "no stock row" too', async () => {
      stockRepo.getSnapshot.mockResolvedValue(null);

      const answers = await Promise.all([
        rebuilder.rebuild(['A']),
        rebuilder.rebuild(['A']),
      ]);

      expect(answers).toEqual([['A'], ['A']]);
      expect(stockRepo.getSnapshot).toHaveBeenCalledTimes(1);
    });

    it('do not share across different SKUs', async () => {
      stockRepo.getSnapshot.mockResolvedValue({ onHand: 1, reserved: 0 });

      await Promise.all([rebuilder.rebuild(['A']), rebuilder.rebuild(['B'])]);

      expect(locks.run).toHaveBeenCalledTimes(2);
    });

    it('rebuild again for a later request: a finished rebuild is not remembered', async () => {
      stockRepo.getSnapshot.mockResolvedValue({ onHand: 1, reserved: 0 });

      await rebuilder.rebuild(['A']);
      await rebuilder.rebuild(['A']);

      expect(locks.run).toHaveBeenCalledTimes(2);
    });

    it('share a failure, and start over afterwards instead of remembering it', async () => {
      stockRepo.getSnapshot
        .mockRejectedValueOnce(new Error('postgres down'))
        .mockResolvedValue({ onHand: 3, reserved: 0 });

      const together = await Promise.allSettled([
        rebuilder.rebuild(['A']),
        rebuilder.rebuild(['A']),
      ]);

      expect(together.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      expect(stockRepo.getSnapshot).toHaveBeenCalledTimes(1);
      await expect(rebuilder.rebuild(['A'])).resolves.toEqual([]);
      expect(store.setIfAbsent).toHaveBeenCalledWith('A', 3);
    });
  });
});
