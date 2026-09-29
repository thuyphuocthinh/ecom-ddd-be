import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({ example: 'some-random-hex-string' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
