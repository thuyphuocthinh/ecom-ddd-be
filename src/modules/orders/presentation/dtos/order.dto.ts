import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ALL_ORDER_STATUSES,
  OrderStatus,
  PaymentMethod,
  type OrderListFilters,
} from '../../domain/index.js';

// A moment with its time zone (`Z` or `+07:00`), so the same text means the same moment everywhere
export const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

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

/** The filters that narrow a list of orders and the count of them. */
export class OrderFilterQueryDto {
  @ApiPropertyOptional({
    description:
      'Only orders placed at or after this moment (ISO 8601 with a time zone, for example 2026-10-01T00:00:00+07:00)',
  })
  @IsOptional()
  @IsString()
  @Matches(ISO_WITH_ZONE, {
    message: 'createdFrom must be an ISO 8601 time with a time zone',
  })
  createdFrom?: string;

  @ApiPropertyOptional({
    description:
      'Only orders placed at or before this moment (ISO 8601 with a time zone)',
  })
  @IsOptional()
  @IsString()
  @Matches(ISO_WITH_ZONE, {
    message: 'createdTo must be an ISO 8601 time with a time zone',
  })
  createdTo?: string;

  @ApiPropertyOptional({
    description:
      'The start of the order id: the 8 characters shown as the order code work (6 to 36 characters from 0-9, a-f and -)',
    example: '3fa85f64',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsString()
  @Matches(/^[0-9a-f-]{6,36}$/, {
    message: 'q must be 6 to 36 characters from 0-9, a-f and -',
  })
  q?: string;

  /**
   * What this request asks for, as the domain wants it (moments as `Date`s). The one place that
   * turns a request's filters into `OrderListFilters`, so a new filter is added here and a
   * controller that lists orders (the customer's, or an admin's later) only calls this.
   */
  toFilters(): OrderListFilters {
    return {
      createdFrom: this.createdFrom ? new Date(this.createdFrom) : undefined,
      createdTo: this.createdTo ? new Date(this.createdTo) : undefined,
      code: this.q,
    };
  }
}

export class ListOrdersQueryDto extends OrderFilterQueryDto {
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

  @ApiPropertyOptional({
    description: 'One or more statuses, separated by commas',
    example: 'PENDING,PAYMENT_PROCESSING',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ALL_ORDER_STATUSES.length)
  @IsEnum(OrderStatus, { each: true })
  status?: OrderStatus[];

  /** Also the statuses, with a status named twice counted once. */
  override toFilters(): OrderListFilters {
    return {
      ...super.toFilters(),
      statuses: this.status ? [...new Set(this.status)] : undefined,
    };
  }
}

/** The same filters as the list, without `status` (the count is already split by status). */
export class CountOrdersQueryDto extends OrderFilterQueryDto {}

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

export class OrderTimelineResponseDto {
  @ApiProperty({ description: 'When the order was placed' })
  placedAt: Date;

  @ApiProperty({ nullable: true })
  confirmedAt: Date | null;

  @ApiProperty({ nullable: true })
  shippedAt: Date | null;

  @ApiProperty({ nullable: true })
  deliveredAt: Date | null;

  @ApiProperty({ nullable: true })
  cancelledAt: Date | null;

  @ApiProperty({ nullable: true })
  expiredAt: Date | null;
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

  @ApiProperty({ type: OrderTimelineResponseDto })
  timeline: OrderTimelineResponseDto;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class OrderSummaryItemResponseDto {
  @ApiProperty()
  productName: string;

  @ApiProperty({ nullable: true })
  thumbnail: string | null;

  @ApiProperty()
  quantity: number;
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

  @ApiProperty({ description: 'How many lines the order has' })
  itemCount: number;

  @ApiProperty({
    type: [OrderSummaryItemResponseDto],
    description: 'The first 3 items, enough to show what the order is about',
  })
  items: OrderSummaryItemResponseDto[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  expiresAt: Date;
}

export class OrderCountsResponseDto {
  @ApiProperty() PENDING: number;
  @ApiProperty() PAYMENT_PROCESSING: number;
  @ApiProperty() CONFIRMED: number;
  @ApiProperty() SHIPPING: number;
  @ApiProperty() DELIVERED: number;
  @ApiProperty() CANCELLED: number;
  @ApiProperty() EXPIRED: number;
}
