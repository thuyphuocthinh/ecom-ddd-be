import { ApiProperty } from '@nestjs/swagger';

export class SkuResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  skuCode: string;

  @ApiProperty({ description: 'The selling price: the price that is charged' })
  price: number;

  @ApiProperty({
    nullable: true,
    description:
      'The price before a discount, shown crossed out. Display only: money is always charged at price',
  })
  compareAtPrice: number | null;

  @ApiProperty({
    description:
      'How much cheaper than compareAtPrice, in whole percent; 0 when not discounted',
  })
  discountPercent: number;

  @ApiProperty({
    required: false,
    description:
      'In stock now (onHand above 0; units held for orders are not taken off). Only in the public endpoints.',
  })
  inStock?: boolean;

  @ApiProperty()
  attributes: Record<string, any>;
}

export class ProductResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  categoryId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ required: false, nullable: true })
  description?: string | null;

  @ApiProperty({ required: false, nullable: true })
  thumbnail?: string | null;

  @ApiProperty()
  status: string;

  @ApiProperty({ type: [SkuResponseDto] })
  skus: SkuResponseDto[];

  @ApiProperty({
    nullable: true,
    description: 'The lowest price among the SKUs ("from ... VND")',
  })
  minPrice: number | null;

  @ApiProperty({ description: 'Some SKU is sold below its original price' })
  onSale: boolean;

  @ApiProperty({
    description:
      'The biggest discount among the SKUs, in whole percent; 0 when none',
  })
  discountPercent: number;

  @ApiProperty({
    required: false,
    description:
      'Some SKU is in stock now. Only in the public endpoints; false means "out of stock".',
  })
  inStock?: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class CategoryProductCountResponseDto {
  @ApiProperty()
  categoryId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({
    description:
      'Published products in the category and every category below it, inside the filters',
  })
  count: number;
}

export class PageMetaResponseDto {
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() hasMore: boolean;
  @ApiProperty({
    description: 'How many products match, counted only up to 1000',
  })
  total: number;
  @ApiProperty({ description: 'More than total products match' })
  totalCapped: boolean;
}
