import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { CartErrorCodes } from '@/core/index.js';
import { SkuLookupService } from '../../../catalog/application/index.js';
import { AddCartItemCommand } from './add-cart-item.command.js';
import { CartDomainException } from '../../domain/index.js';
import type { ICartStore } from '../../domain/index.js';

/** The line after adding: what the cart now holds for the SKU and the price recorded for it. */
export interface CartItemResult {
  skuId: string;
  quantity: number;
  addedPrice: number;
}

@CommandHandler(AddCartItemCommand)
export class AddCartItemHandler implements ICommandHandler<
  AddCartItemCommand,
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
  }: AddCartItemCommand): Promise<CartItemResult> {
    // Only something that can be bought now goes into the cart, at the price it has now
    const sku = (await this.skus.findMany([skuId])).get(skuId);
    if (!sku || !sku.published) {
      throw new CartDomainException(CartErrorCodes.ITEM_NOT_AVAILABLE);
    }

    const outcome = await this.store.add(userId, skuId, quantity, sku.price);
    switch (outcome.kind) {
      case 'OK':
        return { skuId, quantity: outcome.quantity, addedPrice: sku.price };
      case 'LINES_FULL':
        throw new CartDomainException(CartErrorCodes.CART_FULL);
      case 'QUANTITY_EXCEEDED':
        throw new CartDomainException(CartErrorCodes.QUANTITY_LIMIT);
    }
  }
}
