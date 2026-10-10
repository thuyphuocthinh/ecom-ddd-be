import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { RemoveCartItemCommand } from './remove-cart-item.command.js';
import type { ICartStore } from '../../domain/index.js';

@CommandHandler(RemoveCartItemCommand)
export class RemoveCartItemHandler implements ICommandHandler<
  RemoveCartItemCommand,
  void
> {
  constructor(@Inject('ICartStore') private readonly store: ICartStore) {}

  async execute({ userId, skuId }: RemoveCartItemCommand): Promise<void> {
    await this.store.remove(userId, skuId);
  }
}
