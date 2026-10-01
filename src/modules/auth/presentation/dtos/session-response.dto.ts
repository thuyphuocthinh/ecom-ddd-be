import { ApiProperty } from '@nestjs/swagger';
import type { Session } from '../../domain/index.js';

/**
 * A device the user is logged in on. Deliberately leaves out the refresh token
 * hash and the user id: the owner needs neither to recognise a device.
 */
export class SessionResponseDto {
  @ApiProperty({ description: 'Session ID' })
  id!: string;

  @ApiProperty({
    description: 'Device, as the User-Agent it logged in with',
    example: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0',
  })
  deviceName!: string;

  @ApiProperty({ description: 'IP of the most recent use' })
  ipAddress!: string;

  @ApiProperty({ description: 'When this device logged in' })
  createdAt!: Date;

  @ApiProperty({ description: 'Last time this device refreshed its token' })
  lastUsedAt!: Date;

  @ApiProperty({ description: 'True for the session making this request' })
  current!: boolean;

  static from(session: Session, currentSessionId: string): SessionResponseDto {
    return {
      id: session.id,
      deviceName: session.deviceName,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      current: session.id === currentSessionId,
    };
  }
}
