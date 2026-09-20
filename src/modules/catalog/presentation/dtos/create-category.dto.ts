import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCategoryDto {
  @ApiProperty({
    example: 'Áo Nam',
    description: 'Tên danh mục',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    example: 'cat_12345',
    description: 'ID của danh mục cha (nếu có)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  parentId?: string;
}
