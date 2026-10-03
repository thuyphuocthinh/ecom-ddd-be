import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from './normalize-email.js';

export class ResetPasswordDto {
  @ApiProperty({ example: 'user@example.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    example: '482915',
    description: 'The 6-digit code sent to the email address',
  })
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;

  // Length is checked here; easy-to-guess passwords are refused by the handler
  @ApiProperty({ example: 'k9#Tq2$vLm8x', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @IsNotEmpty()
  newPassword!: string;
}
