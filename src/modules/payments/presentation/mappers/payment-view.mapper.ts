import { PaymentStatus, type Payment } from '../../domain/index.js';
import type { PaymentResponseDto } from '../dtos/payment.dto.js';

/**
 * What the outside world sees of a payment. Written out field by field on purpose: the gateway's
 * own reference, the Idempotency-Key, what was collected and the version are internal, and a field
 * added to the entity later must not leak by accident. The link to pay is shown only while there is
 * something to pay.
 */
export class PaymentViewMapper {
  static toView(payment: Payment): PaymentResponseDto {
    return {
      id: payment.id,
      orderId: payment.orderId,
      status: payment.status,
      amount: payment.amount,
      payUrl:
        payment.status === PaymentStatus.INITIATED ? payment.payUrl : null,
      expiresAt: payment.expiresAt,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    };
  }
}
