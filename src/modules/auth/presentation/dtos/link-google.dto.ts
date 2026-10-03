import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { GoogleTokenDto } from './google-token.dto.js';

export class LinkGoogleDto extends GoogleTokenDto {
  @ApiProperty({
    required: false,
    maxLength: 128,
    description:
      'The password of the account. Required when the account has one: it proves the owner is asking, which a stolen access token cannot',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;
}
