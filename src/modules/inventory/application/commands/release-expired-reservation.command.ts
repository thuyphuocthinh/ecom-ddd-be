import { ICommand } from '@nestjs/cqrs';

/** The timer of an order went off: give the units back, but only if the hold really has expired. */
export class ReleaseExpiredReservationCommand implements ICommand {
  constructor(public readonly orderId: string) {}
}
