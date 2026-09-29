import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

export class UserResponseDto {
  @ApiProperty({ description: 'User ID' })
  id: string;

  @ApiProperty({ description: 'User role', enum: UserRole })
  role: UserRole;

  @ApiProperty({ description: 'User display name', required: false })
  displayName: string | null;

  @ApiProperty({ description: 'User avatar URL', required: false })
  avatarUrl: string | null;

  @ApiProperty({ description: 'Account creation time' })
  createdAt: Date;
}
