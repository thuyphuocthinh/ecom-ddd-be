import { IQuery } from '@nestjs/cqrs';

/** The payments of one order of this user, newest first. Somebody else's order is the same as none. */
export class ListOrderPaymentsQuery implements IQuery {
  constructor(
    public readonly userId: string,
    public readonly orderId: string,
  ) {}
}
