import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/index.js';
import type {
  ISessionRepository,
  Session,
  SessionRevokeReason,
} from '../../domain/index.js';
import { SessionMapper } from './session.mapper.js';

@Injectable()
export class PrismaSessionRepository implements ISessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(session: Session): Promise<void> {
    await this.prisma.session.create({
      data: SessionMapper.toPersistence(session),
    });
  }

  async findActiveByRefreshHash(
    hash: string,
    now: Date,
  ): Promise<Session | null> {
    const row = await this.prisma.session.findFirst({
      where: { refreshTokenHash: hash, ...this.live(now) },
    });
    return row ? SessionMapper.toDomain(row) : null;
  }

  async findActiveByPreviousHash(
    hash: string,
    now: Date,
  ): Promise<Session | null> {
    const row = await this.prisma.session.findFirst({
      where: { previousRefreshTokenHash: hash, ...this.live(now) },
    });
    return row ? SessionMapper.toDomain(row) : null;
  }

  async findActiveByUser(userId: string, now: Date): Promise<Session[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, ...this.live(now) },
      orderBy: { lastUsedAt: 'desc' },
    });
    return rows.map(SessionMapper.toDomain);
  }

  async rotate(
    session: Session,
    expectedRefreshHash: string,
    now: Date,
  ): Promise<boolean> {
    // The WHERE clause is the whole race guard: Postgres serialises UPDATEs of
    // one row, and a later one re-checks it against the new value, so of several
    // concurrent rotations of the same token only one matches a row.
    const { count } = await this.prisma.session.updateMany({
      where: {
        id: session.id,
        refreshTokenHash: expectedRefreshHash,
        ...this.live(now),
      },
      data: {
        refreshTokenHash: session.refreshTokenHash,
        previousRefreshTokenHash: session.previousRefreshTokenHash,
        rotatedAt: session.rotatedAt,
        ipAddress: session.ipAddress,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
      },
    });
    return count === 1;
  }

  async revoke(
    id: string,
    userId: string,
    reason: SessionRevokeReason,
    now: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.session.updateMany({
      where: { id, userId, ...this.live(now) },
      data: { revokedAt: now, revokedReason: reason },
    });
    return count === 1;
  }

  async revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    now: Date,
    exceptId?: string,
  ): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.session.findMany({
        where: {
          userId,
          ...this.live(now),
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        select: { id: true },
      });
      const ids = rows.map((row) => row.id);
      if (ids.length > 0) {
        await tx.session.updateMany({
          where: { id: { in: ids }, revokedAt: null },
          data: { revokedAt: now, revokedReason: reason },
        });
      }
      return ids;
    });
  }

  // Not revoked and not expired
  private live(now: Date) {
    return { revokedAt: null, expiresAt: { gt: now } };
  }
}
