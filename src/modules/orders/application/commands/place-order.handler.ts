import {
  CommandBus,
  CommandHandler,
  ICommandHandler,
  QueryBus,
} from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import {
  DomainException,
  InventoryErrorCodes,
  LockService,
  OrderErrorCodes,
} from '@/core/index.js';
import { SkuLookupService } from '../../../catalog/application/index.js';
import { CartOrderingService } from '../../../cart/application/index.js';
import { GetAddressQuery } from '../../../users/application/index.js';
import {
  ReleaseReservationCommand,
  ReserveStockCommand,
  type ReserveStockResult,
} from '../../../inventory/application/index.js';
import type { AddressSnapshot } from '../../../users/domain/index.js';
import {
  Order,
  OrderAlreadyExistsError,
  OrderDomainException,
  PaymentMethod,
  deriveOrderId,
  isValidIdempotencyKey,
  orderCreatedEvent,
  type IOrderRepository,
  type NewOrderItem,
} from '../../domain/index.js';
import { ConfirmOrderCommand } from './confirm-order.command.js';
import type { ConfirmOrderResult } from './confirm-order.handler.js';
import { PlaceOrderCommand } from './place-order.command.js';

export interface PlaceOrderResult {
  order: Order;
  /** True when this is the order of an earlier request with the same key. */
  replayed: boolean;
}

// The lock must outlive the work (a few Redis and Postgres calls); if the process dies holding it,
// the lock lets go by itself after this long
const LOCK_TTL_MS = 30_000;

/**
 * Turns the cart into an order. The order of the steps is what makes it safe to cut short at any
 * point (the table of "what is left if it dies here" is in the spec):
 *
 *  1. Everything slow and everything that can say "no" comes first: the key, the cart, the
 *     catalog, the address. Nothing has been written anywhere yet, and no database connection is
 *     held.
 *  2. The stock is held for the whole order (Redis; this is where buyers compete).
 *  3. ONE short Postgres transaction writes the order, its lines and its event. If it fails, the
 *     hold stays, so the same request sent again goes through.
 *  4. Cash on delivery only: confirm at once (stock out of the warehouse first, then the order).
 *  5. The ordered items leave the cart.
 *
 * Steps 4 and 5 never turn a saved order into a failed request. The whole thing runs under a lock
 * per user, so two requests of one person take turns; the order id is made from the user and the
 * key, so a request sent again finds its own order.
 */
@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<
  PlaceOrderCommand,
  PlaceOrderResult
> {
  private readonly logger = new Logger(PlaceOrderHandler.name);

  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
    private readonly cart: CartOrderingService,
    private readonly skus: SkuLookupService,
    private readonly lock: LockService,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  async execute(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
    const { userId, idempotencyKey, paymentMethod } = command;
    if (!isValidIdempotencyKey(idempotencyKey)) {
      throw new OrderDomainException(OrderErrorCodes.INVALID_IDEMPOTENCY_KEY);
    }
    if (!Object.values(PaymentMethod).includes(paymentMethod)) {
      throw new OrderDomainException(OrderErrorCodes.DOMAIN_EXCEPTION, {
        reason: 'Unknown payment method',
      });
    }
    const orderId = deriveOrderId(userId, idempotencyKey);

    return this.lock.run(
      `order:place:${userId}`,
      () => this.place(command, orderId),
      { ttlMs: LOCK_TTL_MS },
    );
  }

  private async place(
    { userId, idempotencyKey, addressId, paymentMethod }: PlaceOrderCommand,
    orderId: string,
  ): Promise<PlaceOrderResult> {
    // 1. A request sent again gets its own order back
    const existing = await this.orders.findById(orderId);
    if (existing) return { order: existing, replayed: true };

    // 2. Everything that can say "no", before anything is held or written
    const lines = await this.cart.getLines(userId);
    if (lines.length === 0) {
      throw new OrderDomainException(OrderErrorCodes.EMPTY_CART);
    }
    const found = await this.skus.findMany(lines.map((line) => line.skuId));
    const unavailable = lines
      .filter((line) => !found.get(line.skuId)?.published)
      .map((line) => line.skuId);
    if (unavailable.length > 0) {
      throw new OrderDomainException(OrderErrorCodes.ITEM_UNAVAILABLE, {
        skuIds: unavailable,
      });
    }
    const address = await this.queryBus.execute<
      GetAddressQuery,
      AddressSnapshot
    >(new GetAddressQuery(userId, addressId));
    const items: NewOrderItem[] = lines
      .map((line) => {
        const sku = found.get(line.skuId)!;
        return {
          skuId: line.skuId,
          productName: sku.productName,
          thumbnail: sku.thumbnail,
          attributes: sku.attributes,
          // The price NOW, not the one the customer saw when putting it in the cart
          unitPrice: sku.price,
          quantity: line.quantity,
        };
      })
      .sort((a, b) => a.skuId.localeCompare(b.skuId));

    // 3. Hold the stock for the whole order: every item, or nothing
    const hold = await this.hold(orderId, items);

    // 4. Save the order
    let order: Order;
    try {
      order = Order.create({
        userId,
        idempotencyKey,
        paymentMethod,
        shippingAddress: address,
        items,
        expiresAt: hold.expiresAt,
      });
      await this.orders.create(order, orderCreatedEvent(order));
    } catch (error) {
      if (error instanceof OrderAlreadyExistsError) {
        // Another copy of this request saved it first: its hold is OUR hold (same order id), so
        // it must not be given back
        const saved = await this.orders.findById(orderId);
        if (saved) return { order: saved, replayed: true };
      }
      // A refusal that retrying cannot change (the order itself is not acceptable) frees the
      // hold at once. Any other failure (a lost connection, a timeout) KEEPS the hold: the
      // customer sends the same request again and finds the stock still held for this order id.
      // If nobody does, the hold expires by itself.
      if (error instanceof OrderDomainException) await this.giveBack(orderId);
      throw error;
    }

    // 5. Cash on delivery: nothing to wait for, confirm at once
    if (paymentMethod === PaymentMethod.COD) {
      order = await this.confirmNow(order);
    }

    // 6. Take the ordered items out of the cart (the other items stay)
    await this.clearCart(
      userId,
      items.map((item) => item.skuId),
    );

    return { order, replayed: false };
  }

  private async hold(
    orderId: string,
    items: NewOrderItem[],
  ): Promise<ReserveStockResult> {
    try {
      return await this.commandBus.execute(
        new ReserveStockCommand(
          orderId,
          items.map((item) => ({ skuId: item.skuId, qty: item.quantity })),
        ),
      );
    } catch (error) {
      if (
        error instanceof DomainException &&
        error.code === InventoryErrorCodes.OUT_OF_STOCK.code
      ) {
        throw new OrderDomainException(
          OrderErrorCodes.OUT_OF_STOCK,
          error.details,
        );
      }
      throw error;
    }
  }

  /** Never throws: the order is saved, and the sweep confirms it if this does not work. */
  private async confirmNow(order: Order): Promise<Order> {
    try {
      const result: ConfirmOrderResult = await this.commandBus.execute(
        new ConfirmOrderCommand(order.id),
      );
      if (result.kind === 'CONFIRMED') return result.order;
      this.logger.warn(
        `Order ${order.id}: the held stock was already given back; the sweep will expire it`,
      );
    } catch (error) {
      this.logger.warn(
        `Order ${order.id}: could not confirm right away (the sweep will): ${(error as Error).message}`,
      );
    }
    return order;
  }

  private async giveBack(orderId: string): Promise<void> {
    try {
      await this.commandBus.execute(new ReleaseReservationCommand(orderId));
    } catch (error) {
      // The hold expires by itself after a while
      this.logger.error(
        `Order ${orderId}: could not give the held stock back after a failure (it expires by itself): ${(error as Error).message}`,
      );
    }
  }

  private async clearCart(userId: string, skuIds: string[]): Promise<void> {
    try {
      await this.cart.removeLines(userId, skuIds);
    } catch (error) {
      // The order is saved; a cart that still shows the items is only untidy
      this.logger.warn(
        `Order for user ${userId}: could not clear the ordered items from the cart: ${(error as Error).message}`,
      );
    }
  }
}
