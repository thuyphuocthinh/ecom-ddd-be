import { ICommand } from '@nestjs/cqrs';

/**
 * The money of this payment came in (it is SUCCEEDED): confirm the order, or, when the order cannot
 * be confirmed, send the money back. Safe to repeat.
 */
export class FinishPaidPaymentCommand implements ICommand {
  constructor(public readonly paymentId: string) {}
}
