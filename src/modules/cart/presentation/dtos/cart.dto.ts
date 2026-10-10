import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// The real limit of a cart (99 a line) is checked in the cart (CART-002); the bounds here only
// turn away values that make no sense at all.
export class AddCartItemDto {
  @ApiProperty({ description: 'The SKU to add', example: 'seed_sku_flash' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  skuId: string;

  @ApiProperty({
    description: 'Units to ADD to what the cart already holds for this SKU',
    example: 1,
  })
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity: number;
}

export class SetCartItemQuantityDto {
  @ApiProperty({
    description:
      'The units the cart should hold for this SKU (it replaces the old number; sending it again changes nothing)',
    example: 3,
  })
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity: number;
}

export class CartItemResponseDto {
  @ApiProperty()
  skuId: string;

  @ApiProperty({
    description: 'Units in the cart for this SKU after the change',
  })
  quantity: number;

  @ApiProperty({ description: 'The price the cart recorded for this SKU' })
  addedPrice: number;
}

export class CartLineResponseDto {
  @ApiProperty()
  skuId: string;

  @ApiProperty({ nullable: true })
  productId: string | null;

  @ApiProperty({ nullable: true })
  productName: string | null;

  @ApiProperty({ nullable: true })
  thumbnail: string | null;

  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  attributes: Record<string, string> | null;

  @ApiProperty()
  quantity: number;

  @ApiProperty({
    nullable: true,
    description: 'The price now; null when the item is no longer on sale',
  })
  price: number | null;

  @ApiProperty({ description: 'The price when it was put in the cart' })
  addedPrice: number;

  @ApiProperty({
    nullable: true,
    description:
      'Units that can be sold now; null when the item is no longer on sale',
  })
  available: number | null;

  @ApiProperty({
    isArray: true,
    enum: ['priceChanged', 'unpublished', 'outOfStock', 'notEnoughStock'],
  })
  flags: string[];
}

export class CartResponseDto {
  @ApiProperty({ type: [CartLineResponseDto] })
  items: CartLineResponseDto[];

  @ApiProperty({
    description: 'Total of the lines that can be ordered as they are',
  })
  subtotal: number;

  @ApiProperty()
  lineCount: number;

  @ApiProperty()
  quantityCount: number;
}
