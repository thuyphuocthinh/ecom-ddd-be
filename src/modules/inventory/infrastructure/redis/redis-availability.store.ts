import { Injectable, Logger } from '@nestjs/common';
import { CACHE, InventoryErrorCodes, RedisService } from '@/core/index.js';
import {
  InventoryDomainException,
  type HoldResult,
  type IAvailabilityStore,
  type Shortage,
  type StockItem,
} from '../../domain/index.js';
import {
  GIVE_BACK_SCRIPT,
  HOLD_SCRIPT,
  UNDO_HOLD_SCRIPT,
} from './availability.scripts.js';

const KEYS = CACHE.INVENTORY.KEYS;

// Codes the HOLD script answers with (see availability.scripts.ts)
const HELD = 0;
const MISSING = 1;
const SHORT = 2;
const IN_PROGRESS = 3;

/**
 * The stock numbers in Redis, through the Lua scripts. Fails closed: any Redis error becomes
 * `INV-007`, so a caller can never sell stock it could not check.
 */
@Injectable()
export class RedisAvailabilityStore implements IAvailabilityStore {
  private readonly logger = new Logger(RedisAvailabilityStore.name);

  constructor(private readonly redis: RedisService) {}

  async hold(
    orderId: string,
    fingerprint: string,
    items: StockItem[],
  ): Promise<HoldResult> {
    const record = JSON.stringify({ fingerprint, items });
    const reply = (await this.run((client) =>
      client.eval(
        HOLD_SCRIPT,
        2 + items.length,
        KEYS.INFLIGHT(orderId),
        KEYS.INFLIGHT_INDEX,
        ...items.map((item) => KEYS.AVAILABLE(item.skuId)),
        orderId,
        record,
        CACHE.INVENTORY.SETTINGS.INFLIGHT_RECORD_TTL,
        ...items.map((item) => item.qty),
      ),
    )) as number[];

    const [code, ...rest] = reply.map(Number);
    switch (code) {
      case HELD:
        return { kind: 'HELD' };
      case IN_PROGRESS:
        return { kind: 'IN_PROGRESS' };
      case MISSING:
        // rest = positions (1-based) of the items Redis has no number for
        return {
          kind: 'MISSING',
          skuIds: rest.map((position) => items[position - 1].skuId),
        };
      case SHORT: {
        // rest = position, units Redis has, position, units Redis has, ...
        const shortages: Shortage[] = [];
        for (let i = 0; i < rest.length; i += 2) {
          const item = items[rest[i] - 1];
          shortages.push({
            skuId: item.skuId,
            requested: item.qty,
            available: rest[i + 1],
          });
        }
        return { kind: 'SHORT', shortages };
      }
      default:
        this.logger.error(`Unexpected answer from the hold script: ${code}`);
        throw this.unavailable();
    }
  }

  async peek(skuIds: string[]): Promise<Map<string, number | null>> {
    const numbers = new Map<string, number | null>();
    if (skuIds.length === 0) return numbers;
    const values = await this.run((client) =>
      client.mget(...skuIds.map((skuId) => KEYS.AVAILABLE(skuId))),
    );
    skuIds.forEach((skuId, index) => {
      const value = values[index];
      numbers.set(skuId, value === null ? null : Number(value));
    });
    return numbers;
  }

  async finishHold(orderId: string): Promise<void> {
    await this.run((client) =>
      client
        .multi()
        .del(KEYS.INFLIGHT(orderId))
        .zrem(KEYS.INFLIGHT_INDEX, orderId)
        .exec(),
    );
  }

  async undoHold(orderId: string, items: StockItem[]): Promise<boolean> {
    const done = await this.run((client) =>
      client.eval(
        UNDO_HOLD_SCRIPT,
        2 + items.length,
        KEYS.INFLIGHT(orderId),
        KEYS.INFLIGHT_INDEX,
        ...items.map((item) => KEYS.AVAILABLE(item.skuId)),
        orderId,
        ...items.map((item) => item.qty),
      ),
    );
    return Number(done) === 1;
  }

  async readInflight(orderId: string): Promise<StockItem[] | null> {
    const raw = await this.run((client) => client.get(KEYS.INFLIGHT(orderId)));
    if (raw === null) return null;
    try {
      const record = JSON.parse(raw) as { items: StockItem[] };
      return record.items;
    } catch {
      this.logger.error(
        `The being-held record of order ${orderId} is unreadable`,
      );
      return null;
    }
  }

  async listStaleInflight(
    olderThanMs: number,
    limit: number,
  ): Promise<string[]> {
    return this.run(async (client) => {
      // The scores are Redis-clock milliseconds, so the cut-off must come from the same clock
      const [seconds, microseconds] = await client.time();
      const now =
        Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
      return client.zrangebyscore(
        KEYS.INFLIGHT_INDEX,
        '-inf',
        now - olderThanMs,
        'LIMIT',
        0,
        limit,
      );
    });
  }

  async giveBack(items: StockItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.run((client) =>
      client.eval(
        GIVE_BACK_SCRIPT,
        items.length,
        ...items.map((item) => KEYS.AVAILABLE(item.skuId)),
        ...items.map((item) => item.qty),
      ),
    );
  }

  async setIfAbsent(skuId: string, available: number): Promise<boolean> {
    const written = await this.run((client) =>
      client.set(KEYS.AVAILABLE(skuId), String(available), 'NX'),
    );
    return written === 'OK';
  }

  async delete(skuIds: string[]): Promise<void> {
    if (skuIds.length === 0) return;
    await this.run((client) =>
      client.del(...skuIds.map((skuId) => KEYS.AVAILABLE(skuId))),
    );
  }

  /** Runs one Redis call; any failure becomes INV-007 (and is logged without the data). */
  private async run<T>(
    call: (client: ReturnType<RedisService['getClient']>) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(this.redis.getClient());
    } catch (error) {
      if (error instanceof InventoryDomainException) throw error;
      this.logger.error(`Redis call failed: ${(error as Error).message}`);
      throw this.unavailable();
    }
  }

  private unavailable(): InventoryDomainException {
    return new InventoryDomainException(InventoryErrorCodes.STOCK_UNAVAILABLE);
  }
}
