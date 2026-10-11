import { AggregateRoot, HashUtil, InventoryErrorCodes } from '@/core/index.js';
import { InventoryDomainException } from '../exceptions/inventory.exception.js';

export enum ReservationStatus {
  /** Held for an unpaid order; counts against what can be sold. */
  RESERVED = 'RESERVED',
  /** Paid: the units were taken out of the warehouse stock. Only a return can move it on. */
  CONFIRMED = 'CONFIRMED',
  /** Cancelled or expired before it was paid: the units were given back. Final. */
  RELEASED = 'RELEASED',
  /** Was CONFIRMED, then the order was cancelled before delivery: the units were put back. Final. */
  RETURNED = 'RETURNED',
}

export interface StockItem {
  skuId: string;
  qty: number;
}

export interface ReservationProps {
  orderId: string;
  /** Sorted by skuId, so two requests with the same content compare equal. */
  items: StockItem[];
  status: ReservationStatus;
  expiresAt: Date;
}

const ORDER_ID_MAX_LENGTH = 100; // the column is VARCHAR(100)

/**
 * The stock held for one order: one line per SKU. Its id is the order id.
 *
 * Moving a reservation to another status does NOT happen here: it is one conditional SQL update in
 * the repository (`WHERE status = 'RESERVED'`, or 'CONFIRMED' for a return), so that when a payment
 * and an expiry arrive together exactly one of them wins. Loading the entity, changing it and
 * saving it back could let both win.
 */
export class Reservation extends AggregateRoot<ReservationProps> {
  static readonly MAX_ITEMS = 50;
  static readonly MAX_QTY_PER_ITEM = 1000;

  /** A new RESERVED reservation, or `INV-002` when the request is not acceptable. */
  static create(
    orderId: string,
    items: ReadonlyArray<StockItem>,
    now: Date,
    ttlSeconds: number,
  ): Reservation {
    Reservation.validate(orderId, items);
    return new Reservation(
      {
        orderId,
        items: Reservation.sorted(items),
        status: ReservationStatus.RESERVED,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      },
      orderId,
    );
  }

  /** Rebuilds a stored reservation (no validation: it was validated when it was made). */
  static restore(props: ReservationProps): Reservation {
    return new Reservation(
      { ...props, items: Reservation.sorted(props.items) },
      props.orderId,
    );
  }

  get orderId(): string {
    return this.props.orderId;
  }
  get items(): StockItem[] {
    return this.props.items.map((item) => ({ ...item }));
  }
  get status(): ReservationStatus {
    return this.props.status;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  /** A hash of what is held, to tell a retried request from a different one for the same order. */
  fingerprint(): string {
    return HashUtil.sha256(JSON.stringify(this.props.items));
  }

  hasSameContentAs(items: ReadonlyArray<StockItem>): boolean {
    return (
      JSON.stringify(Reservation.sorted(items)) ===
      JSON.stringify(this.props.items)
    );
  }

  private static sorted(items: ReadonlyArray<StockItem>): StockItem[] {
    return items
      .map(({ skuId, qty }) => ({ skuId, qty }))
      .sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0));
  }

  private static validate(
    orderId: string,
    items: ReadonlyArray<StockItem>,
  ): void {
    const refuse = (message: string): never => {
      throw new InventoryDomainException(
        InventoryErrorCodes.INVALID_RESERVATION_REQUEST,
        message,
      );
    };

    if (
      typeof orderId !== 'string' ||
      orderId.trim() === '' ||
      orderId.length > ORDER_ID_MAX_LENGTH
    ) {
      refuse(`orderId must be 1 to ${ORDER_ID_MAX_LENGTH} characters`);
    }
    if (!Array.isArray(items) || items.length === 0) {
      refuse('An order must hold at least one item');
    }
    if (items.length > Reservation.MAX_ITEMS) {
      refuse(`An order can hold at most ${Reservation.MAX_ITEMS} items`);
    }

    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item?.skuId !== 'string' || item.skuId.trim() === '') {
        refuse('Every item needs a skuId');
      }
      if (
        !Number.isInteger(item.qty) ||
        item.qty < 1 ||
        item.qty > Reservation.MAX_QTY_PER_ITEM
      ) {
        refuse(
          `qty of ${item.skuId} must be a whole number from 1 to ${Reservation.MAX_QTY_PER_ITEM}`,
        );
      }
      if (seen.has(item.skuId)) {
        refuse(`SKU ${item.skuId} appears more than once in the order`);
      }
      seen.add(item.skuId);
    }
  }
}
