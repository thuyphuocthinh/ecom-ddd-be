import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Only the fields that are sent are changed. There is no `isDefault` here (use
 * PUT /users/me/addresses/:id/default); any field that is not listed is refused.
 */
export class UpdateAddressDto {
  @ApiPropertyOptional({ example: 'Nguyễn Văn A' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  recipientName?: string;

  @ApiPropertyOptional({ example: '0912345678' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional({
    description: 'Another ward; the province follows from it',
    example: '00004',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  wardCode?: string;

  @ApiPropertyOptional({ example: '12 Bạch Đằng' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  street?: string;

  @ApiPropertyOptional({
    description: 'null removes the label',
    nullable: true,
    example: 'Công ty',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  label?: string | null;
}
