import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationQueryDto } from '@/core/index.js';

/**
 * The public product list. It has no `status` on purpose: customers only ever
 * get PUBLISHED products, and the global ValidationPipe rejects a `status`
 * query parameter as an unknown field. Admins use `AdminGetProductsDto`.
 */
export class GetProductsDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Filter products by category ID. Includes the products of every sub-category.',
  })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({
    description: 'Search products by name or description',
  })
  @IsOptional()
  @IsString()
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
