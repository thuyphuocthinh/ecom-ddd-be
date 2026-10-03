import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GoogleTokenDto {
  @ApiProperty({
    description:
      'The `credential` Google Identity Services hands to the page (a JWT signed by Google)',
    maxLength: 4096,
  })
  @IsString()
  @MaxLength(4096)
  @IsNotEmpty()
  idToken!: string;

  @ApiProperty({
    required: false,
    maxLength: 128,
    description:
      'The nonce given to Google when signing in, if any. Required to match when the token carries one',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  nonce?: string;
}
