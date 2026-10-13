import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { WithCursorPagination, WithPageNumber } from '@/core/index.js';
import { PRODUCT_SORTS, type ProductSort } from '../../domain/index.js';
import { PublicProductFilterDto } from './product-filter.dto.js';

/**
 * The public product list. There is no `status` on purpose: customers only ever get PUBLISHED
 * products, and the global ValidationPipe rejects a `status` query parameter as an unknown field.
 * Read it by `cursor` ("load more", newest first) or by `page` (a numbered page, any sort), not both.
 */
export class SearchProductsDto extends WithPageNumber(
  WithCursorPagination(PublicProductFilterDto),
) {
  @ApiPropertyOptional({
    description:
      'Filter products by category ID. Includes the products of every sub-category.',
  })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({
    enum: PRODUCT_SORTS,
    default: 'newest',
    description:
      'newest (the default), price_asc, price_desc, or relevance (needs `search`). `cursor` only works with newest.',
  })
  @IsOptional()
  @IsIn(PRODUCT_SORTS)
  sort: ProductSort = 'newest';
}
