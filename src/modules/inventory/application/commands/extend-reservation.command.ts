import { ICommand } from '@nestjs/cqrs';

/**
 * The customer started paying: keep the held units for at least `seconds` more from now (never
 * shorter than the hold already is), so the hold does not run out in the middle of a payment.
 */
export class ExtendReservationCommand implements ICommand {
  constructor(
    public readonly orderId: string,
    public readonly seconds: number,
  ) {}
}
