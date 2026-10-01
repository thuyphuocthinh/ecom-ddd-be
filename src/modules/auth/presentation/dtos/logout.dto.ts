import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Logout ends the session the access token belongs to, so no body is needed.
 * `refreshToken` is still accepted (older clients send it) but ignored; it must
 * be declared because unknown body fields are rejected.
 */
export class LogoutDto {
  @ApiPropertyOptional({
    description: 'Ignored. Kept so existing clients keep working.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  refreshToken?: string;
}
