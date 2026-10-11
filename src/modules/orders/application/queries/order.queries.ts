import { IQuery } from '@nestjs/cqrs';

/** One order of this user. Somebody else's order is the same as no order. */
export class GetOrderQuery implements IQuery {
  constructor(
    public readonly userId: string,
    public readonly orderId: string,
  ) {}
}

/** The orders of this user, newest first. `cursor` is the id of the last order of the previous page. */
export class ListOrdersQuery implements IQuery {
  constructor(
    public readonly userId: string,
    public readonly limit: number,
    public readonly cursor?: string,
  ) {}
}
