import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { ClearCartCommand } from './clear-cart.command.js';
import type { ICartStore } from '../../domain/index.js';

@CommandHandler(ClearCartCommand)
export class ClearCartHandler implements ICommandHandler<
  ClearCartCommand,
  void
> {
  constructor(@Inject('ICartStore') private readonly store: ICartStore) {}

  async execute({ userId }: ClearCartCommand): Promise<void> {
    await this.store.clear(userId);
  }
}
