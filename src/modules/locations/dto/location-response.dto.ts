import { ApiProperty } from '@nestjs/swagger';
import { ProvinceType, WardType } from '@prisma/client';

export class ProvinceDto {
  @ApiProperty({ description: 'Code of the province: 2 digits', example: '01' })
  code: string;

  @ApiProperty({ description: 'Name without the kind', example: 'Hà Nội' })
  name: string;

  @ApiProperty({
    description: 'Name with the kind',
    example: 'Thành phố Hà Nội',
  })
  fullName: string;

  @ApiProperty({ enum: ProvinceType })
  type: ProvinceType;
}

export class WardDto {
  @ApiProperty({ description: 'Code of the ward: 5 digits', example: '00004' })
  code: string;

  @ApiProperty({ description: 'Name without the kind', example: 'Ba Đình' })
  name: string;

  @ApiProperty({
    description: 'Name with the kind',
    example: 'Phường Ba Đình',
  })
  fullName: string;

  @ApiProperty({ enum: WardType })
  type: WardType;
}

/** A ward together with the province it belongs to (what other modules ask for). */
export class WardWithProvinceDto extends WardDto {
  @ApiProperty({ type: ProvinceDto })
  province: ProvinceDto;
}
