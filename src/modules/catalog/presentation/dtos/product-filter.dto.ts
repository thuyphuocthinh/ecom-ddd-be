import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/** The filters every product list shares: a word, and a price range. */
export class ProductFilterDto {
  @ApiPropertyOptional({
    description: 'Search products by name or description',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Minimum price filter' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minPrice?: number;

  @ApiPropertyOptional({ description: 'Maximum price filter' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  maxPrice?: number;
}

/**
 * What only the public lists can narrow by. Both take only `true` (to filter) or nothing:
 * `false` or any other word is refused, so there is no "false means no filter" to misread.
 */
export class PublicProductFilterDto extends ProductFilterDto {
  @ApiPropertyOptional({
    enum: ['true'],
    description:
      'Only products with at least one SKU in stock (units held for orders are not taken off)',
  })
  @IsOptional()
  @IsIn(['true'])
  inStock?: 'true';

  @ApiPropertyOptional({
    enum: ['true'],
    description:
      'Only products with at least one SKU sold below its original price',
  })
  @IsOptional()
  @IsIn(['true'])
  onSale?: 'true';
}
