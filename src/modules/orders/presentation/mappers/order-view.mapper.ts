import type { Order, OrderStatusCounts } from '../../domain/index.js';
import type {
  OrderCountsResponseDto,
  OrderResponseDto,
  OrderSummaryResponseDto,
} from '../dtos/order.dto.js';

/** How many items a line of the list shows. */
const SUMMARY_ITEMS = 3;

/**
 * What the outside world sees of an order. Written out field by field on purpose: the user id, the
 * Idempotency-Key, the version and the stock flag are internal, and a field added to the entity
 * later must not leak by accident.
 */
export class OrderViewMapper {
  static toDetail(order: Order): OrderResponseDto {
    return {
      id: order.id,
      status: order.status,
      paymentMethod: order.paymentMethod,
      total: order.total,
      items: order.items.map((item) => ({
        skuId: item.skuId,
        productName: item.productName,
        thumbnail: item.thumbnail,
        attributes: item.attributes,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
      })),
      shippingAddress: {
        recipientName: order.shippingAddress.recipientName,
        phone: order.shippingAddress.phone,
        provinceCode: order.shippingAddress.provinceCode,
        provinceName: order.shippingAddress.provinceName,
        wardCode: order.shippingAddress.wardCode,
        wardName: order.shippingAddress.wardName,
        street: order.shippingAddress.street,
        label: order.shippingAddress.label,
      },
      expiresAt: order.expiresAt,
      timeline: {
        placedAt: order.createdAt,
        confirmedAt: order.timeline.confirmedAt,
        shippedAt: order.timeline.shippedAt,
        deliveredAt: order.timeline.deliveredAt,
        cancelledAt: order.timeline.cancelledAt,
        expiredAt: order.timeline.expiredAt,
      },
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  static toSummary(order: Order): OrderSummaryResponseDto {
    return {
      id: order.id,
      status: order.status,
      paymentMethod: order.paymentMethod,
      total: order.total,
      itemCount: order.itemCount,
      items: order.items.slice(0, SUMMARY_ITEMS).map((item) => ({
        productName: item.productName,
        thumbnail: item.thumbnail,
        quantity: item.quantity,
      })),
      createdAt: order.createdAt,
      expiresAt: order.expiresAt,
    };
  }

  static toCounts(counts: OrderStatusCounts): OrderCountsResponseDto {
    return {
      PENDING: counts.PENDING,
      PAYMENT_PROCESSING: counts.PAYMENT_PROCESSING,
      CONFIRMED: counts.CONFIRMED,
      SHIPPING: counts.SHIPPING,
      DELIVERED: counts.DELIVERED,
      CANCELLED: counts.CANCELLED,
      EXPIRED: counts.EXPIRED,
    };
  }
}
