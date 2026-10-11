import { ICommand } from '@nestjs/cqrs';

/** Admin: a confirmed order leaves the warehouse (CONFIRMED to SHIPPING). Simulated delivery. */
export class ShipOrderCommand implements ICommand {
  constructor(public readonly orderId: string) {}
}

/** Admin: the order reached the customer (SHIPPING to DELIVERED). Simulated delivery. */
export class DeliverOrderCommand implements ICommand {
  constructor(public readonly orderId: string) {}
}
