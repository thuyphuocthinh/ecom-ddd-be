import { Inject, Injectable } from '@nestjs/common';
import { LockService } from '@/core/index.js';
import type {
  IAvailabilityStore,
  IStockRepository,
} from '../../domain/index.js';

/**
 * Gives Redis a number again for SKUs it lost, from what Postgres says:
 * `available = onHand - units held by RESERVED reservations`.
 *
 * Rebuilding is several steps across two systems (read Postgres, compute, write Redis), so a Lua
 * script cannot make it indivisible. Two requests that find the key missing at the same moment
 * could both rebuild, and the slower one would overwrite a number that a customer's hold had
 * already lowered, selling stock twice. So it works under a lock per SKU, checks again inside the
 * lock whether somebody already rebuilt, and writes only if Redis still has no number.
 * Nothing on the normal buying path takes this lock: it is only here when Redis lost its numbers.
 *
 * Inside one server process, requests that need the same SKU at the same moment share ONE
 * rebuild instead of each waiting for the lock. LockService polls every 50 ms, and hundreds of
 * waiters in one process wake up together, so only one of them gets the lock per round: 200
 * requests would need 10 s and many would give up with a "busy" error. The lock is still what
 * keeps different servers from rebuilding the same SKU at once.
 */
@Injectable()
export class StockRebuilder {
  private readonly running = new Map<string, Promise<boolean>>();

  constructor(
    @Inject('IStockRepository') private readonly stockRepo: IStockRepository,
    @Inject('IAvailabilityStore') private readonly store: IAvailabilityStore,
    private readonly locks: LockService,
  ) {}

  /**
   * Makes sure Redis has a number for each SKU that has stock. Returns the SKUs that have no stock
   * row at all: those get no number (so a made-up SKU id cannot fill Redis) and count as sold out.
   */
  async rebuild(skuIds: ReadonlyArray<string>): Promise<string[]> {
    const withoutStock: string[] = [];
    // One lock at a time and always in the same order, so two rebuilds can never wait on each other
    for (const skuId of [...skuIds].sort()) {
      if (!(await this.rebuildShared(skuId))) withoutStock.push(skuId);
    }
    return withoutStock;
  }

  /** Joins the rebuild of this SKU that is already running here, or starts it. */
  private rebuildShared(skuId: string): Promise<boolean> {
    const running = this.running.get(skuId);
    if (running) return running;

    // A failure is shared by everyone who joined and is not remembered: the next call starts over
    const started = this.locks
      .run(`inventory:rebuild:${skuId}`, () => this.rebuildOne(skuId))
      .finally(() => this.running.delete(skuId));
    this.running.set(skuId, started);
    return started;
  }

  private async rebuildOne(skuId: string): Promise<boolean> {
    const current = (await this.store.peek([skuId])).get(skuId);
    if (current !== null && current !== undefined) return true; // somebody just rebuilt it

    const snapshot = await this.stockRepo.getSnapshot(skuId);
    if (!snapshot) return false;

    await this.store.setIfAbsent(
      skuId,
      Math.max(0, snapshot.onHand - snapshot.reserved),
    );
    return true;
  }
}
