import { describe, it, expect } from 'vitest';
import type { Session as PrismaSession } from '@prisma/client';
import { SessionMapper } from './session.mapper.js';
import { Session } from '../../domain/index.js';

const row: PrismaSession = {
  id: 'sid-1',
  userId: 'user-1',
  refreshTokenHash: 'hash-2',
  previousRefreshTokenHash: 'hash-1',
  rotatedAt: new Date('2026-09-30T10:00:00Z'),
  deviceName: 'Chrome',
  ipAddress: '203.0.113.7',
  lastUsedAt: new Date('2026-09-30T10:00:00Z'),
  createdAt: new Date('2026-09-29T10:00:00Z'),
  expiresAt: new Date('2026-10-07T10:00:00Z'),
  revokedAt: new Date('2026-09-30T11:00:00Z'),
  revokedReason: 'REUSE_DETECTED',
};

describe('SessionMapper', () => {
  it('maps a row to a domain Session with every field intact', () => {
    const session = SessionMapper.toDomain(row);

    expect(session).toBeInstanceOf(Session);
    expect(session).toMatchObject(row);
  });

  it('keeps the original creation time (does not stamp a new one)', () => {
    expect(SessionMapper.toDomain(row).createdAt).toEqual(row.createdAt);
  });

  it('round-trips through persistence unchanged', () => {
    expect(SessionMapper.toPersistence(SessionMapper.toDomain(row))).toEqual(
      row,
    );
  });
});
