import type {
  Order as PrismaOrder,
  OrderItem as PrismaOrderItem,
} from '@prisma/client';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  type OrderItem,
  type ShippingAddress,
} from '../../../domain/index.js';

export type PrismaOrderWithItems = PrismaOrder & { items: PrismaOrderItem[] };

export class OrderMapper {
  static toDomain(row: PrismaOrderWithItems): Order {
    return Order.restore({
      id: row.id,
      userId: row.userId,
      idempotencyKey: row.idempotencyKey,
      paymentMethod: row.paymentMethod as PaymentMethod,
      status: row.status as OrderStatus,
      version: row.version,
      stockReturnPending: row.stockReturnPending,
      total: Number(row.total),
      shippingAddress: row.shippingAddress as unknown as ShippingAddress,
      // The same order every time we read it, whatever order Postgres returns the rows in
      items: [...row.items]
        .sort((a, b) => a.skuId.localeCompare(b.skuId))
        .map((item): OrderItem => ({
          skuId: item.skuId,
          productName: item.productName,
          thumbnail: item.thumbnail,
          attributes: item.attributes as Record<string, string>,
          unitPrice: Number(item.unitPrice),
          quantity: item.quantity,
          lineTotal: Number(item.lineTotal),
        })),
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      timeline: {
        confirmedAt: row.confirmedAt,
        shippedAt: row.shippedAt,
        deliveredAt: row.deliveredAt,
        cancelledAt: row.cancelledAt,
        expiredAt: row.expiredAt,
      },
    });
  }
}
