import { ICommand } from '@nestjs/cqrs';

/** The customer starts paying one of their online orders. The same key is the same payment. */
export class StartPaymentCommand implements ICommand {
  constructor(
    public readonly userId: string,
    public readonly orderId: string,
    public readonly idempotencyKey: string,
  ) {}
}
