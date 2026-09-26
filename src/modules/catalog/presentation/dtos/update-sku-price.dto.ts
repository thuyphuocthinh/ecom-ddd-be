import { IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSkuPriceDto {
  @ApiProperty({ description: 'New price for the SKU', minimum: 0 })
  @IsNumber()
  @Min(0)
  price: number;
}
