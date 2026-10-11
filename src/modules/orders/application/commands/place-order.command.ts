import { ICommand } from '@nestjs/cqrs';
import type { PaymentMethod } from '../../domain/index.js';

/** Turn the cart into an order. The same `idempotencyKey` from the same user is the same order. */
export class PlaceOrderCommand implements ICommand {
  constructor(
    public readonly userId: string,
    public readonly idempotencyKey: string,
    public readonly addressId: string,
    public readonly paymentMethod: PaymentMethod,
  ) {}
}
