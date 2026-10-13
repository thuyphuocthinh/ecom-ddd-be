import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PublicProductFilterDto } from './product-filter.dto.js';

/** The filters of the public list, except the category: the counts are per category. */
export class FacetsQueryDto extends PublicProductFilterDto {
  @ApiPropertyOptional({
    description:
      'Count the categories directly under this one. Leave out for the root categories.',
  })
  @IsOptional()
  @IsString()
  parentId?: string;
}
