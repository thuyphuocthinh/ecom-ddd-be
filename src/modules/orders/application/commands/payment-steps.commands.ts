import { ICommand } from '@nestjs/cqrs';

/**
 * The customer started paying an online order: PENDING becomes PAYMENT_PROCESSING and the time to
 * pay becomes `expiresAt` (the held stock was extended to the same time).
 */
export class StartOrderPaymentCommand implements ICommand {
  constructor(
    public readonly orderId: string,
    public readonly expiresAt: Date,
  ) {}
}

/** The payment failed: PAYMENT_PROCESSING goes back to PENDING so the customer can try again. */
export class ReopenOrderCommand implements ICommand {
  constructor(public readonly orderId: string) {}
}

/**
 * The order ran out of time (or its held stock was lost): PENDING or PAYMENT_PROCESSING becomes
 * EXPIRED and the stock still held is given back.
 */
export class ExpireOrderCommand implements ICommand {
  constructor(public readonly orderId: string) {}
}
