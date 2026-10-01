import type { Session as PrismaSession } from '@prisma/client';
import { Session } from '../../domain/index.js';

export class SessionMapper {
  static toDomain(row: PrismaSession): Session {
    return new Session({
      id: row.id,
      userId: row.userId,
      refreshTokenHash: row.refreshTokenHash,
      previousRefreshTokenHash: row.previousRefreshTokenHash,
      rotatedAt: row.rotatedAt,
      deviceName: row.deviceName,
      ipAddress: row.ipAddress,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      revokedReason: row.revokedReason,
    });
  }

  static toPersistence(session: Session): PrismaSession {
    return {
      id: session.id,
      userId: session.userId,
      refreshTokenHash: session.refreshTokenHash,
      previousRefreshTokenHash: session.previousRefreshTokenHash,
      rotatedAt: session.rotatedAt,
      deviceName: session.deviceName,
      ipAddress: session.ipAddress,
      lastUsedAt: session.lastUsedAt,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      revokedReason: session.revokedReason,
    };
  }
}
