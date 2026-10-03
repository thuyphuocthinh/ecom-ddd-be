import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @ApiProperty({
    description:
      'New display name: 1 to 100 visible characters (spaces are tidied)',
    example: 'Nguyễn Văn A',
  })
  @IsString()
  // Cleaning happens in the handler; this only stops absurdly long input early
  @MaxLength(300)
  displayName: string;
}
