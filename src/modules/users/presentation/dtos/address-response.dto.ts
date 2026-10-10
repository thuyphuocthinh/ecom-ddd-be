import { ApiProperty } from '@nestjs/swagger';

export class AddressResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Nguyễn Văn A' })
  recipientName: string;

  @ApiProperty({ example: '0912345678' })
  phone: string;

  @ApiProperty({ example: '01' })
  provinceCode: string;

  @ApiProperty({ example: 'Thành phố Hà Nội' })
  provinceName: string;

  @ApiProperty({ example: '00004' })
  wardCode: string;

  @ApiProperty({ example: 'Phường Ba Đình' })
  wardName: string;

  @ApiProperty({ example: '12 Bạch Đằng' })
  street: string;

  @ApiProperty({ nullable: true, example: 'Nhà' })
  label: string | null;

  @ApiProperty()
  isDefault: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
