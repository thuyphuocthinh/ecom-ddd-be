import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  ValidateNested,
  IsNumber,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SkuDto {
  @ApiProperty({ example: 150000, description: 'Giá của SKU (VND)' })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({
    example: { color: 'Red', size: 'XL' },
    description: 'Thuộc tính cấu hình của SKU',
  })
  @IsNotEmpty()
  attributes: Record<string, string>;

  @ApiProperty({
    example: 'SKU-RED-XL',
    description: 'Mã SKU duy nhất',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  skuCode: string;

  @ApiPropertyOptional({
    example: '8931234567890',
    description: 'Mã vạch (Barcode)',
    maxLength: 50,
  })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  barcode?: string;
}

export class CreateProductDto {
  @ApiProperty({
    example: 'cat_123',
    description: 'ID của danh mục',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  categoryId: string;

  @ApiProperty({
    example: 'Áo thun nam',
    description: 'Tên sản phẩm',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    example: 'Áo thun cotton 100%...',
    description: 'Mô tả chi tiết sản phẩm',
    maxLength: 5000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({
    example: 'https://example.com/image.png',
    description: 'URL ảnh đại diện',
    maxLength: 1000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  thumbnail?: string;

  @ApiPropertyOptional({
    type: [SkuDto],
    description: 'Danh sách các phiên bản (SKU) của sản phẩm',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SkuDto)
  @IsOptional()
  skus?: SkuDto[];
}
