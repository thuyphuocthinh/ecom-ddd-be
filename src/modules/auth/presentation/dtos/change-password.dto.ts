import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({
    example: 'the-password-in-use-now',
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @IsNotEmpty()
  currentPassword!: string;

  // Length is checked here; easy-to-guess and unchanged passwords are refused by the handler
  @ApiProperty({ example: 'k9#Tq2$vLm8x', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @IsNotEmpty()
  newPassword!: string;
}
