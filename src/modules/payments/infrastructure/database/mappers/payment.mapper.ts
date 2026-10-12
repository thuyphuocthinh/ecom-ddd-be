import type { Payment as PrismaPayment } from '@prisma/client';
import { Payment, PaymentStatus } from '../../../domain/index.js';

export class PaymentMapper {
  static toDomain(row: PrismaPayment): Payment {
    return Payment.restore({
      id: row.id,
      orderId: row.orderId,
      idempotencyKey: row.idempotencyKey,
      provider: row.provider,
      status: row.status as PaymentStatus,
      version: row.version,
      amount: Number(row.amount),
      paidAmount: row.paidAmount === null ? null : Number(row.paidAmount),
      providerRef: row.providerRef,
      payUrl: row.payUrl,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
