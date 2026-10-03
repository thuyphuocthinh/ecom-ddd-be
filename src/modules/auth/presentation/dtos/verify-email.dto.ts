import { IsEmail, IsNotEmpty, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from './normalize-email.js';

export class VerifyEmailDto {
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
}
