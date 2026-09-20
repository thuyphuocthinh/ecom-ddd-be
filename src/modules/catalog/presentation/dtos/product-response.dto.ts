import { ApiProperty } from '@nestjs/swagger';

export class SkuResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  skuCode: string;

  @ApiProperty()
  price: number;

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

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
