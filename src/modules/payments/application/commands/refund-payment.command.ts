import { ICommand } from '@nestjs/cqrs';

/**
 * Sends the money of a payment back to the customer. Safe to repeat: the gateway refunds a payment
 * once however often it is asked.
 *
 * Works on a payment that is REFUND_PENDING. With `markFirst` it also takes a SUCCEEDED payment and
 * moves it to REFUND_PENDING itself: only for a caller that has checked that the order is closed
 * (cancelled or expired), never for a payment whose order is alive.
 */
export class RefundPaymentCommand implements ICommand {
  constructor(
    public readonly paymentId: string,
    public readonly options: { markFirst?: boolean } = {},
  ) {}
}
