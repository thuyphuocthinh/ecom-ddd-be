import { OrderErrorCodes } from '@/core/index.js';
import { OrderDomainException } from '../exceptions/order.exception.js';
import {
  FINAL_STATUSES,
  OrderStatus,
  PaymentMethod,
  canTransition,
} from '../order-status.js';
import {
  computeTotal,
  deriveOrderId,
  isValidIdempotencyKey,
  lineTotal,
} from '../services/order-identity.js';

/** The same limits inventory applies when it holds stock for an order. */
export const MAX_ORDER_ITEMS = 50;
export const MAX_QUANTITY_PER_ITEM = 1000;
/** The most the total column can hold: Decimal(12,2). */
export const MAX_ORDER_TOTAL = 9_999_999_999.99;

/** Where the order goes, as it was when the order was placed. */
export interface ShippingAddress {
  recipientName: string;
  phone: string;
  provinceCode: string;
  provinceName: string;
  wardCode: string;
  wardName: string;
  street: string;
  label: string | null;
}

/** One line of an order, as it was when the order was placed. */
export interface OrderItem {
  skuId: string;
  productName: string;
  thumbnail: string | null;
  attributes: Record<string, string>;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface NewOrderItem {
  skuId: string;
  productName: string;
  thumbnail: string | null;
  attributes: Record<string, string>;
  unitPrice: number;
  quantity: number;
}

const refuse = (reason: string): never => {
  throw new OrderDomainException(OrderErrorCodes.DOMAIN_EXCEPTION, { reason });
};

/**
 * An order: a copy of what was bought (items, address, prices) taken when it was placed, plus
 * where it is in its life. Changing the status does NOT happen here: it is one conditional SQL
 * update in the repository (`WHERE status = <old status>`), so that when two things reach the same
 * order together (a cancel and an expiry) exactly one of them wins.
 */
export class Order {
  private constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly idempotencyKey: string,
    public readonly paymentMethod: PaymentMethod,
    public readonly status: OrderStatus,
    public readonly version: number,
    /** Cancelled after its stock was taken out of the warehouse, and the stock is not back yet. */
    public readonly stockReturnPending: boolean,
    public readonly total: number,
    public readonly shippingAddress: ShippingAddress,
    public readonly items: readonly OrderItem[],
    /** Online: when the time to pay runs out (the stock hold expires then too). */
    public readonly expiresAt: Date,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  /**
   * A new PENDING order. Its id comes from the user and the Idempotency-Key. Throws
   * `ORD-005` for a key that is not acceptable and `ORD-000` for anything else that is wrong (a
   * mistake in the caller: the items and the address come from checked data).
   */
  static create(params: {
    userId: string;
    idempotencyKey: string;
    paymentMethod: PaymentMethod;
    shippingAddress: ShippingAddress;
    items: ReadonlyArray<NewOrderItem>;
    expiresAt: Date;
    now?: Date;
  }): Order {
    if (!isValidIdempotencyKey(params.idempotencyKey)) {
      throw new OrderDomainException(OrderErrorCodes.INVALID_IDEMPOTENCY_KEY);
    }
    if (typeof params.userId !== 'string' || params.userId === '') {
      refuse('An order needs a user');
    }
    if (!Object.values(PaymentMethod).includes(params.paymentMethod)) {
      refuse('Unknown payment method');
    }
    if (params.items.length === 0) refuse('An order needs at least one item');
    if (params.items.length > MAX_ORDER_ITEMS) {
      refuse(`An order can have at most ${MAX_ORDER_ITEMS} items`);
    }
    if (
      new Set(params.items.map((i) => i.skuId)).size !== params.items.length
    ) {
      refuse('A SKU can appear only once in an order');
    }
    if (Number.isNaN(params.expiresAt.getTime())) refuse('Invalid expiry');

    const items: OrderItem[] = params.items.map((item) => {
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > MAX_QUANTITY_PER_ITEM
      ) {
        refuse(
          `Quantity of ${item.skuId} must be a whole number from 1 to ${MAX_QUANTITY_PER_ITEM}`,
        );
      }
      if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
        refuse(`Price of ${item.skuId} cannot be negative`);
      }
      return {
        skuId: item.skuId,
        productName: item.productName,
        thumbnail: item.thumbnail,
        attributes: item.attributes,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        lineTotal: lineTotal(item.unitPrice, item.quantity),
      };
    });

    const total = computeTotal(items);
    if (total > MAX_ORDER_TOTAL) refuse('The total is too large');

    const now = params.now ?? new Date();
    return new Order(
      deriveOrderId(params.userId, params.idempotencyKey),
      params.userId,
      params.idempotencyKey,
      params.paymentMethod,
      OrderStatus.PENDING,
      1,
      false,
      total,
      params.shippingAddress,
      items,
      params.expiresAt,
      now,
      now,
    );
  }

  /** Rebuilds an order read from the database (nothing is checked again). */
  static restore(data: {
    id: string;
    userId: string;
    idempotencyKey: string;
    paymentMethod: PaymentMethod;
    status: OrderStatus;
    version: number;
    stockReturnPending: boolean;
    total: number;
    shippingAddress: ShippingAddress;
    items: OrderItem[];
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }): Order {
    return new Order(
      data.id,
      data.userId,
      data.idempotencyKey,
      data.paymentMethod,
      data.status,
      data.version,
      data.stockReturnPending,
      data.total,
      data.shippingAddress,
      data.items,
      data.expiresAt,
      data.createdAt,
      data.updatedAt,
    );
  }

  get isFinal(): boolean {
    return FINAL_STATUSES.includes(this.status);
  }

  /** Whether this order may move to `to` from where it is now. */
  canMoveTo(to: OrderStatus): boolean {
    return canTransition(this.status, to, this.paymentMethod);
  }

  get itemCount(): number {
    return this.items.length;
  }
}
