import { Injectable, Logger } from '@nestjs/common';
import { CACHE, CartErrorCodes, RedisService } from '@/core/index.js';
import {
  CartDomainException,
  MAX_CART_LINES,
  MAX_QUANTITY_PER_LINE,
  type AddOutcome,
  type CartLine,
  type ICartStore,
  type SetOutcome,
} from '../../domain/index.js';
import {
  ADD_SCRIPT,
  READ_SCRIPT,
  REMOVE_SCRIPT,
  SET_SCRIPT,
} from './cart.scripts.js';

const KEY = CACHE.CART.KEYS.CART;
const TTL_SECONDS = CACHE.CART.SETTINGS.TTL;

// Codes the scripts answer with (see cart.scripts.ts)
const DONE = 0;
const LINES_FULL = 1; // for ADD
const NOT_IN_CART = 1; // for SET
const OVER_QUANTITY = 2;

/**
 * The carts in Redis, through the Lua scripts. Any Redis error becomes CART-005: the cart is not
 * available, and nothing half-done is left behind because every change is one script.
 */
@Injectable()
export class RedisCartStore implements ICartStore {
  private readonly logger = new Logger(RedisCartStore.name);

  constructor(private readonly redis: RedisService) {}

  async add(
    userId: string,
    skuId: string,
    quantity: number,
    price: number,
  ): Promise<AddOutcome> {
    const reply = (await this.run((client) =>
      client.eval(
        ADD_SCRIPT,
        1,
        KEY(userId),
        skuId,
        quantity,
        price,
        MAX_CART_LINES,
        MAX_QUANTITY_PER_LINE,
        TTL_SECONDS,
      ),
    )) as [number, number?];

    switch (reply[0]) {
      case DONE:
        return { kind: 'OK', quantity: Number(reply[1]) };
      case LINES_FULL:
        return { kind: 'LINES_FULL' };
      case OVER_QUANTITY:
        return { kind: 'QUANTITY_EXCEEDED' };
      default:
        throw this.unexpected(reply);
    }
  }

  async setQuantity(
    userId: string,
    skuId: string,
    quantity: number,
    price: number | null,
  ): Promise<SetOutcome> {
    const reply = (await this.run((client) =>
      client.eval(
        SET_SCRIPT,
        1,
        KEY(userId),
        skuId,
        quantity,
        price === null ? '' : price,
        MAX_QUANTITY_PER_LINE,
        TTL_SECONDS,
      ),
    )) as [number, number?, string?];

    switch (reply[0]) {
      case DONE:
        return {
          kind: 'OK',
          quantity: Number(reply[1]),
          addedPrice: Number(reply[2]),
        };
      case NOT_IN_CART:
        return { kind: 'NOT_IN_CART' };
      case OVER_QUANTITY:
        return { kind: 'QUANTITY_EXCEEDED' };
      default:
        throw this.unexpected(reply);
    }
  }

  async remove(userId: string, skuId: string): Promise<void> {
    await this.run((client) =>
      client.eval(REMOVE_SCRIPT, 1, KEY(userId), skuId, TTL_SECONDS),
    );
  }

  async clear(userId: string): Promise<void> {
    await this.run((client) => client.del(KEY(userId)));
  }

  async read(userId: string): Promise<CartLine[]> {
    const flat = (await this.run((client) =>
      client.eval(READ_SCRIPT, 1, KEY(userId)),
    )) as string[];

    const lines: CartLine[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const line = this.parse(flat[i], flat[i + 1]);
      if (line) lines.push(line);
    }
    return lines;
  }

  /** A line that is not what the scripts write is left out (and noted, without its content). */
  private parse(skuId: string, json: string): CartLine | null {
    try {
      const raw = JSON.parse(json) as { q?: unknown; p?: unknown; t?: unknown };
      if (
        Number.isInteger(raw.q) &&
        (raw.q as number) > 0 &&
        typeof raw.p === 'number' &&
        typeof raw.t === 'number'
      ) {
        return {
          skuId,
          quantity: raw.q as number,
          addedPrice: raw.p,
          addedAt: raw.t,
        };
      }
    } catch {
      // falls through to the warning below
    }
    this.logger.warn('A cart line could not be read and was left out');
    return null;
  }

  /** Runs one Redis call; any failure becomes CART-005 (and is logged without the data). */
  private async run<T>(
    call: (client: ReturnType<RedisService['getClient']>) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(this.redis.getClient());
    } catch (error) {
      this.logger.error(`Redis call failed: ${(error as Error).message}`);
      throw new CartDomainException(CartErrorCodes.CART_UNAVAILABLE);
    }
  }

  private unexpected(reply: unknown): CartDomainException {
    this.logger.error(`A cart script answered ${JSON.stringify(reply)}`);
    return new CartDomainException(CartErrorCodes.CART_UNAVAILABLE);
  }
}
