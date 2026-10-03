import { ApiProperty } from '@nestjs/swagger';
import { AuthResponseDto } from './auth-response.dto.js';

export class GoogleLoginResponseDto extends AuthResponseDto {
  @ApiProperty({
    description:
      'True when this sign-in created the account (a good moment to ask for a profile)',
  })
  isNewUser!: boolean;
}
