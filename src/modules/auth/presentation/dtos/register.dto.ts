import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from './normalize-email.js';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  @IsNotEmpty()
  email!: string;

  // Length is checked here; easy-to-guess passwords are refused by the register handler
  @ApiProperty({ example: 'k9#Tq2$vLm8x', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @IsNotEmpty()
  password!: string;

  @ApiProperty({ example: 'John Doe', required: false, maxLength: 255 })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  displayName?: string;
}
