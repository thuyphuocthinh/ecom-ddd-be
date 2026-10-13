import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { WithCursorPagination } from '@/core/index.js';
import { ProductFilterDto } from './product-filter.dto.js';

/**
 * The product list of the admin (`AdminGetProductsDto` adds `status`): a word, a price range, a
 * category, and a cursor. It has no `status` here and no sort, page, stock or discount filters:
 * the global ValidationPipe rejects what is not declared. The public list is `SearchProductsDto`.
 */
export class GetProductsDto extends WithCursorPagination(ProductFilterDto) {
  @ApiPropertyOptional({
    description:
      'Filter products by category ID. Includes the products of every sub-category.',
  })
  @IsOptional()
  @IsString()
  categoryId?: string;
}
