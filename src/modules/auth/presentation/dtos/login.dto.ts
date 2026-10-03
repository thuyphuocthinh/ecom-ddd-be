import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from './normalize-email.js';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  @IsNotEmpty()
  email!: string;

  // Same length bounds as register. Only the shape is checked here: whether the password is easy
  // to guess is judged when it is chosen (register), not on every login.
  // MaxLength also keeps argon2 from hashing an arbitrarily large body.
  @ApiProperty({ example: 'k9#Tq2$vLm8x', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @IsNotEmpty()
  password!: string;
}
