import { describe, it, expect } from 'vitest';
import { Session } from './session.entity.js';

const NOW = new Date('2026-09-30T10:00:00Z');
const TTL = 604800; // 7 days
const ABSOLUTE = 2592000; // 30 days

const start = (overrides: Partial<Parameters<typeof Session.start>[0]> = {}) =>
  Session.start({
    id: 'sid-1',
    userId: 'user-1',
    refreshTokenHash: 'hash-1',
    userAgent: 'Mozilla/5.0 Chrome/128.0',
    ipAddress: '203.0.113.7',
    now: NOW,
    refreshTtlSeconds: TTL,
    absoluteTtlSeconds: ABSOLUTE,
    ...overrides,
  });

describe('Session', () => {
  describe('start', () => {
    it('creates a live session that has never been rotated', () => {
      const session = start();

      expect(session).toMatchObject({
        id: 'sid-1',
        userId: 'user-1',
        refreshTokenHash: 'hash-1',
        previousRefreshTokenHash: null,
        rotatedAt: null,
        ipAddress: '203.0.113.7',
        lastUsedAt: NOW,
        createdAt: NOW,
        revokedAt: null,
        revokedReason: null,
      });
      expect(session.isActive(NOW)).toBe(true);
    });

    it('expires one refresh TTL after it starts', () => {
      expect(start().expiresAt).toEqual(new Date(NOW.getTime() + TTL * 1000));
    });

    it('never lives past the absolute lifetime, even when the refresh TTL is longer', () => {
      const session = start({ refreshTtlSeconds: 100, absoluteTtlSeconds: 50 });

      expect(session.expiresAt).toEqual(new Date(NOW.getTime() + 50 * 1000));
    });

    it('uses the User-Agent as the device name, trimmed', () => {
      expect(
        start({ userAgent: '  Mozilla/5.0 Chrome/128.0  ' }).deviceName,
      ).toBe('Mozilla/5.0 Chrome/128.0');
    });

    it('truncates a very long User-Agent to 255 characters', () => {
      expect(start({ userAgent: 'x'.repeat(1000) }).deviceName).toHaveLength(
        255,
      );
    });

    it('falls back to "Unknown device" when the client sent no User-Agent', () => {
      expect(start({ userAgent: '' }).deviceName).toBe('Unknown device');
      expect(start({ userAgent: '   ' }).deviceName).toBe('Unknown device');
    });

    it('drops control characters from the User-Agent (it is stored, shown back and may reach logs)', () => {
      const session = start({
        userAgent:
          'Chrome/128' +
          String.fromCharCode(13, 10) +
          'X-Injected: yes' +
          String.fromCharCode(0, 127, 9) +
          'end',
      });

      expect(session.deviceName).toBe('Chrome/128X-Injected: yesend');
    });

    it('truncates an over-long IP to the column size', () => {
      expect(start({ ipAddress: '1'.repeat(200) }).ipAddress).toHaveLength(64);
    });
  });

  describe('rotate', () => {
    const later = new Date(NOW.getTime() + 3_600_000);

    const rotated = () => {
      const session = start();
      session.rotate({
        newRefreshTokenHash: 'hash-2',
        ipAddress: '198.51.100.9',
        now: later,
        refreshTtlSeconds: TTL,
        absoluteTtlSeconds: ABSOLUTE,
      });
      return session;
    };

    it('swaps in the new token hash and keeps the replaced one as previous', () => {
      const session = rotated();

      expect(session.refreshTokenHash).toBe('hash-2');
      expect(session.previousRefreshTokenHash).toBe('hash-1');
    });

    it('records when it rotated, the latest IP and last use', () => {
      const session = rotated();

      expect(session.rotatedAt).toEqual(later);
      expect(session.lastUsedAt).toEqual(later);
      expect(session.ipAddress).toBe('198.51.100.9');
    });

    it('extends the expiry from the rotation time (sliding)', () => {
      expect(rotated().expiresAt).toEqual(
        new Date(later.getTime() + TTL * 1000),
      );
    });

    describe('absolute lifetime', () => {
      const day = 86_400_000;
      const rotateAt = (session: Session, at: Date) =>
        session.rotate({
          newRefreshTokenHash: 'hash-n',
          ipAddress: '203.0.113.7',
          now: at,
          refreshTtlSeconds: TTL,
          absoluteTtlSeconds: ABSOLUTE,
        });

      it('does not extend a session past its absolute lifetime: a refresh on day 29 expires on day 30, not day 36', () => {
        const session = start();

        rotateAt(session, new Date(NOW.getTime() + 29 * day));

        expect(session.expiresAt).toEqual(new Date(NOW.getTime() + 30 * day));
      });

      it('keeps the full sliding window while the cap is far away', () => {
        const session = start();
        const at = new Date(NOW.getTime() + 10 * day);

        rotateAt(session, at);

        expect(session.expiresAt).toEqual(new Date(at.getTime() + TTL * 1000));
      });

      it('is no longer active once the absolute lifetime is reached, however recently it was used', () => {
        const session = start();
        rotateAt(session, new Date(NOW.getTime() + 29 * day));

        expect(session.isActive(new Date(NOW.getTime() + 30 * day - 1))).toBe(
          true,
        );
        expect(session.isActive(new Date(NOW.getTime() + 30 * day))).toBe(
          false,
        );
      });
    });

    it('keeps its identity, device and creation time', () => {
      const session = rotated();

      expect(session.id).toBe('sid-1');
      expect(session.deviceName).toBe('Mozilla/5.0 Chrome/128.0');
      expect(session.createdAt).toEqual(NOW);
    });
  });

  describe('revoke / isActive', () => {
    it('is no longer active once revoked, and remembers when and why', () => {
      const session = start();
      session.revoke('LOGOUT', NOW);

      expect(session.isActive(NOW)).toBe(false);
      expect(session.revokedAt).toEqual(NOW);
      expect(session.revokedReason).toBe('LOGOUT');
    });

    it('is not active at or after its expiry', () => {
      const session = start();

      expect(session.isActive(new Date(session.expiresAt.getTime() - 1))).toBe(
        true,
      );
      expect(session.isActive(session.expiresAt)).toBe(false);
    });
  });

  describe('isWithinGrace', () => {
    const rotatedAt = (secondsAgo: number) => {
      const session = start();
      session.rotate({
        newRefreshTokenHash: 'hash-2',
        ipAddress: '203.0.113.7',
        now: new Date(NOW.getTime() - secondsAgo * 1000),
        refreshTtlSeconds: TTL,
        absoluteTtlSeconds: ABSOLUTE,
      });
      return session;
    };

    it('is false for a session that was never rotated', () => {
      expect(start().isWithinGrace(NOW, 15)).toBe(false);
    });

    it('is true just inside the window and false at or past it', () => {
      expect(rotatedAt(14).isWithinGrace(NOW, 15)).toBe(true);
      expect(rotatedAt(15).isWithinGrace(NOW, 15)).toBe(false);
      expect(rotatedAt(60).isWithinGrace(NOW, 15)).toBe(false);
    });
  });
});
