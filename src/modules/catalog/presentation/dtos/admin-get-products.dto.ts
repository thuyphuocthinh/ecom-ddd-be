import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ProductStatus } from '../../domain/index.js';
import { GetProductsDto } from './get-products.dto.js';

/**
 * The product list for admins: same filters as the public list, plus `status`.
 * Left empty it returns every status (draft products included).
 */
export class AdminGetProductsDto extends GetProductsDto {
  @ApiPropertyOptional({
    enum: ProductStatus,
    description: 'Filter by product status. Leave empty for every status.',
  })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}
