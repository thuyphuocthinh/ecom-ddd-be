import { ICommand } from '@nestjs/cqrs';

/**
 * Take the held stock out of the warehouse and move the order to CONFIRMED. Used for cash on
 * delivery right after the order is saved (and by the sweep when that was cut short); the payment
 * module will use it for an online order once it is paid.
 */
export class ConfirmOrderCommand implements ICommand {
  constructor(public readonly orderId: string) {}
}
