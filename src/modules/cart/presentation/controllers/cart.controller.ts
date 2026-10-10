import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AddCartItemCommand,
  ClearCartCommand,
  GetCartQuery,
  RemoveCartItemCommand,
  SetCartItemQuantityCommand,
} from '../../application/index.js';
import type { CartItemResult } from '../../application/index.js';
import type { CartView } from '../../domain/index.js';
import {
  AddCartItemDto,
  CartItemResponseDto,
  CartResponseDto,
  SetCartItemQuantityDto,
} from '../dtos/cart.dto.js';
import {
  JwtAuthGuard,
  CurrentUser,
  RateLimit,
  buildTTL,
} from '@/core/index.js';
import type { ICurrentUser } from '@/core/index.js';

// Each route is counted on its own: 60 calls per user per minute
const LIMIT = {
  limit: 60,
  window: buildTTL('MINUTE', 1),
  key: 'user',
} as const;

/** The cart of the signed-in user. There is no way to name another user here. */
@ApiTags('Cart')
@Controller('cart')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CartController {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

  @Get()
  @RateLimit(LIMIT)
  @ApiOperation({
    summary:
      'My cart, with the price, stock and flags looked up again (newest item first)',
  })
  @ApiResponse({ status: 200, type: CartResponseDto })
  async get(@CurrentUser() user: ICurrentUser): Promise<CartView> {
    return this.queryBus.execute(new GetCartQuery(user.id));
  }

  @Post('items')
  @RateLimit(LIMIT)
  @ApiOperation({
    summary:
      'Add units of a SKU to the cart (added to what is already there, so sending it twice adds twice)',
  })
  @ApiResponse({ status: 201, type: CartItemResponseDto })
  @ApiResponse({ status: 404, description: 'Not available (CART-003)' })
  @ApiResponse({
    status: 409,
    description: 'Cart full (CART-001) or too many of one item (CART-002)',
  })
  async add(
    @CurrentUser() user: ICurrentUser,
    @Body() dto: AddCartItemDto,
  ): Promise<CartItemResult> {
    return this.commandBus.execute(
      new AddCartItemCommand(user.id, dto.skuId, dto.quantity),
    );
  }

  @Put('items/:skuId')
  @RateLimit(LIMIT)
  @ApiOperation({
    summary:
      'Set the units of a SKU already in the cart (sending it again changes nothing)',
  })
  @ApiParam({ name: 'skuId' })
  @ApiResponse({ status: 200, type: CartItemResponseDto })
  @ApiResponse({ status: 404, description: 'Not in the cart (CART-004)' })
  @ApiResponse({ status: 409, description: 'Too many of one item (CART-002)' })
  async setQuantity(
    @CurrentUser() user: ICurrentUser,
    @Param('skuId') skuId: string,
    @Body() dto: SetCartItemQuantityDto,
  ): Promise<CartItemResult> {
    return this.commandBus.execute(
      new SetCartItemQuantityCommand(user.id, skuId, dto.quantity),
    );
  }

  @Delete('items/:skuId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(LIMIT)
  @ApiOperation({
    summary: 'Take a SKU out of the cart (also when it is not there)',
  })
  @ApiParam({ name: 'skuId' })
  @ApiResponse({ status: 204 })
  async removeItem(
    @CurrentUser() user: ICurrentUser,
    @Param('skuId') skuId: string,
  ): Promise<void> {
    await this.commandBus.execute(new RemoveCartItemCommand(user.id, skuId));
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(LIMIT)
  @ApiOperation({ summary: 'Empty the cart (also when it is already empty)' })
  @ApiResponse({ status: 204 })
  async clear(@CurrentUser() user: ICurrentUser): Promise<void> {
    await this.commandBus.execute(new ClearCartCommand(user.id));
  }
}
