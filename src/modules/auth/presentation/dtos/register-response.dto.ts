import { ApiProperty } from '@nestjs/swagger';

export class RegisterResponseDto {
  @ApiProperty({
    description:
      'Always true: the account is created only after the emailed code is entered (POST /auth/verify-email)',
    example: true,
  })
  verificationRequired!: true;

  @ApiProperty({
    description:
      'Seconds to wait before another code can be requested; 0 when the email could not be sent, so the user can ask again at once',
    example: 300,
  })
  resendAvailableInSeconds!: number;

  @ApiProperty({
    description:
      'Seconds the registration is kept. After that the user must register again; asking for another code will not help',
    example: 1800,
  })
  verificationExpiresInSeconds!: number;
}

export class ResendVerificationResponseDto {
  @ApiProperty({
    description:
      'Seconds to wait before another code can be requested; 0 when the email could not be sent, so the user can ask again at once',
    example: 300,
  })
  resendAvailableInSeconds!: number;
}
