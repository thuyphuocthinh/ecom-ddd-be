import type { Order } from '../../domain/index.js';
import type {
  OrderResponseDto,
  OrderSummaryResponseDto,
} from '../dtos/order.dto.js';

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
      createdAt: order.createdAt,
      expiresAt: order.expiresAt,
    };
  }
}
