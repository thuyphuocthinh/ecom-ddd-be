import { ICommand } from '@nestjs/cqrs';

/** The customer cancels their own order before it ships (PENDING or CONFIRMED). */
export class CancelOrderCommand implements ICommand {
  constructor(
    public readonly userId: string,
    public readonly orderId: string,
  ) {}
}
