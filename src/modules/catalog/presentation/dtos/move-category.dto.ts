import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsNotEmpty } from 'class-validator';

export class MoveCategoryDto {
  @ApiProperty({
    description:
      'ID of the new parent category. Send null or omit to move to root.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  newParentId?: string | null;
}
