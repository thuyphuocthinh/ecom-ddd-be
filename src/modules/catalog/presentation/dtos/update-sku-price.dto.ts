import { IsNumber, IsOptional, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateSkuPriceDto {
  @ApiProperty({ description: 'New price for the SKU', minimum: 0 })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The price before a discount (shown crossed out), greater than price. A number sets it, null removes the discount, leaving it out keeps what is there. Display only: money is always charged at price',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  compareAtPrice?: number | null;
}
