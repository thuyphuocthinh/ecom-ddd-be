import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import {
  AddCartItemHandler,
  SetCartItemQuantityHandler,
  RemoveCartItemHandler,
  ClearCartHandler,
  GetCartHandler,
} from './application/index.js';
import { RedisCartStore } from './infrastructure/index.js';
import { CartController } from './presentation/controllers/cart.controller.js';

/**
 * The cart of each signed-in user, in Redis. The price, the stock and whether an item is still on
 * sale are looked up again at every view through the services that CatalogModule and
 * InventoryModule export. The cart never holds stock; that happens when an order is placed.
 */
@Module({
  imports: [CqrsModule, CatalogModule, InventoryModule],
  controllers: [CartController],
  providers: [
    { provide: 'ICartStore', useClass: RedisCartStore },
    AddCartItemHandler,
    SetCartItemQuantityHandler,
    RemoveCartItemHandler,
    ClearCartHandler,
    GetCartHandler,
  ],
})
export class CartModule {}
