import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { OrderStatus, PaymentMethod } from '../../domain/index.js';

export class PlaceOrderDto {
  @ApiProperty({
    description: 'One of the addresses in your address book',
    example: '0b6f3d3a-2f6b-4a53-8f0e-1d6f2f6f0c11',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  addressId: string;

  @ApiProperty({
    enum: PaymentMethod,
    description:
      'ONLINE: pay before delivery, 15 minutes from now. COD: pay in cash on delivery; the order is confirmed at once.',
  })
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;
}

export class ListOrdersQueryDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'The `meta.nextCursor` of the previous page',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;
}

export class OrderItemResponseDto {
  @ApiProperty()
  skuId: string;

  @ApiProperty()
  productName: string;

  @ApiProperty({ nullable: true })
  thumbnail: string | null;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  attributes: Record<string, string>;

  @ApiProperty({ description: 'The price when the order was placed' })
  unitPrice: number;

  @ApiProperty()
  quantity: number;

  @ApiProperty()
  lineTotal: number;
}

export class ShippingAddressResponseDto {
  @ApiProperty()
  recipientName: string;

  @ApiProperty()
  phone: string;

  @ApiProperty()
  provinceCode: string;

  @ApiProperty()
  provinceName: string;

  @ApiProperty()
  wardCode: string;

  @ApiProperty()
  wardName: string;

  @ApiProperty()
  street: string;

  @ApiProperty({ nullable: true })
  label: string | null;
}

export class OrderResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: OrderStatus })
  status: OrderStatus;

  @ApiProperty({ enum: PaymentMethod })
  paymentMethod: PaymentMethod;

  @ApiProperty()
  total: number;

  @ApiProperty({ type: [OrderItemResponseDto] })
  items: OrderItemResponseDto[];

  @ApiProperty({ type: ShippingAddressResponseDto })
  shippingAddress: ShippingAddressResponseDto;

  @ApiProperty({
    description:
      'Online orders: when the time to pay runs out. Meaningless for cash on delivery.',
  })
  expiresAt: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class OrderSummaryResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: OrderStatus })
  status: OrderStatus;

  @ApiProperty({ enum: PaymentMethod })
  paymentMethod: PaymentMethod;

  @ApiProperty()
  total: number;

  @ApiProperty()
  itemCount: number;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  expiresAt: Date;
}
