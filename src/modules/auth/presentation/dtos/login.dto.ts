import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from './normalize-email.js';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @NormalizeEmail()
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  // No MinLength: accounts created under an older, looser policy must still be able to log in.
  // MaxLength keeps argon2 from hashing an arbitrarily large body.
  @ApiProperty({ example: 'password123' })
  @IsString()
  @MaxLength(128)
  @IsNotEmpty()
  password!: string;
}
