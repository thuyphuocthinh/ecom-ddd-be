import { ICommand } from '@nestjs/cqrs';

/**
 * The order was cancelled after it was paid and before it was delivered: put the units that were
 * taken out of the warehouse back, whatever the expiry says.
 */
export class ReturnReservationCommand implements ICommand {
  constructor(public readonly orderId: string) {}
}
