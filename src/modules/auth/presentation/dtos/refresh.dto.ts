import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({ example: 'some-random-hex-string' })
  @IsString()
  @IsNotEmpty()
  // Issued tokens are 80 hex characters; anything much longer can't be one
  @MaxLength(128)
  refreshToken!: string;
}
