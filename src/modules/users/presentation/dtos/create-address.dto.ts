import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

// The texts are tidied and checked against their real limits in the domain (ADDR-003); the
// lengths here only stop absurdly long input early.
export class CreateAddressDto {
  @ApiProperty({
    description: 'Who receives the parcel',
    example: 'Nguyễn Văn A',
  })
  @IsString()
  @MaxLength(500)
  recipientName: string;

  @ApiProperty({
    description: '10 digits starting with 0; +84 and separators are accepted',
    example: '0912345678',
  })
  @IsString()
  @MaxLength(50)
  phone: string;

  @ApiProperty({
    description:
      'Code of the ward, commune or special zone (from GET /locations/provinces/:code/wards); the province follows from it',
    example: '00004',
  })
  @IsString()
  @MaxLength(20)
  wardCode: string;

  @ApiProperty({
    description: 'House number and street',
    example: '12 Bạch Đằng',
  })
  @IsString()
  @MaxLength(1000)
  street: string;

  @ApiPropertyOptional({
    description:
      'A name for the address, such as "Nhà" or "Công ty" (at most 50 characters)',
    example: 'Nhà',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  label?: string | null;

  @ApiPropertyOptional({
    description:
      'Make this the default address (the first address is always the default)',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
