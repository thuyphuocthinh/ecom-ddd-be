import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '@/core/index.js';

export class GetProductsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter products by category ID' })
  @IsOptional()
  @IsString()
  categoryId?: string;
}
