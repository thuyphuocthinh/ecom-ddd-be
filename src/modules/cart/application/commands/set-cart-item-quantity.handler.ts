import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { CartErrorCodes } from '@/core/index.js';
import { SkuLookupService } from '../../../catalog/application/index.js';
import { SetCartItemQuantityCommand } from './set-cart-item-quantity.command.js';
import type { CartItemResult } from './add-cart-item.handler.js';
import { CartDomainException } from '../../domain/index.js';
import type { ICartStore } from '../../domain/index.js';

@CommandHandler(SetCartItemQuantityCommand)
export class SetCartItemQuantityHandler implements ICommandHandler<
  SetCartItemQuantityCommand,
  CartItemResult
> {
  constructor(
    @Inject('ICartStore') private readonly store: ICartStore,
    private readonly skus: SkuLookupService,
  ) {}

  async execute({
    userId,
    skuId,
    quantity,
  }: SetCartItemQuantityCommand): Promise<CartItemResult> {
    // The customer has just seen the price now, so it becomes the recorded price. An item that is
    // no longer on sale keeps the price it had: it can still be reduced or taken out.
    const sku = (await this.skus.findMany([skuId])).get(skuId);
    const price = sku?.published ? sku.price : null;

    const outcome = await this.store.setQuantity(
      userId,
      skuId,
      quantity,
      price,
    );
    switch (outcome.kind) {
      case 'OK':
        return {
          skuId,
          quantity: outcome.quantity,
          addedPrice: outcome.addedPrice,
        };
      case 'NOT_IN_CART':
        throw new CartDomainException(CartErrorCodes.ITEM_NOT_IN_CART);
      case 'QUANTITY_EXCEEDED':
        throw new CartDomainException(CartErrorCodes.QUANTITY_LIMIT);
    }
  }
}
