import { ICommand } from '@nestjs/cqrs';

/** The order was paid: take the held units out of the warehouse stock for good. */
export class ConfirmReservationCommand implements ICommand {
  constructor(public readonly orderId: string) {}
}
