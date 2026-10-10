import { ICommand } from '@nestjs/cqrs';

/** The order was cancelled: give the held units back now, whatever the expiry says. */
export class ReleaseReservationCommand implements ICommand {
  constructor(public readonly orderId: string) {}
}
