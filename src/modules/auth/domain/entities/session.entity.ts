export type SessionRevokeReason =
  | 'LOGOUT'
  | 'LOGOUT_OTHERS'
  | 'LOGOUT_ALL'
  | 'REUSE_DETECTED'
  | 'ADMIN'
  // The password was reset (every session closed) or changed (the other sessions closed)
  | 'PASSWORD_RESET'
  | 'PASSWORD_CHANGED';

export interface SessionProps {
  id: string;
  userId: string;
  refreshTokenHash: string;
  previousRefreshTokenHash: string | null;
  rotatedAt: Date | null;
  deviceName: string;
  ipAddress: string;
  lastUsedAt: Date;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokeReason | null;
}

const DEVICE_NAME_MAX_LENGTH = 255;
const IP_ADDRESS_MAX_LENGTH = 64;
const UNKNOWN_DEVICE = 'Unknown device';

/**
 * One login on one device. Its `id` is the `sid` carried in the access token.
 *
 * Only the sha256 of the refresh token is kept, never the token itself.
 * `previousRefreshTokenHash` remembers the token the last rotation replaced, so
 * a token that was already exchanged but shows up again can be recognised (and
 * told apart from a random string).
 */
export class Session {
  readonly id: string;
  readonly userId: string;
  readonly deviceName: string;
  readonly createdAt: Date;

  refreshTokenHash: string;
  previousRefreshTokenHash: string | null;
  rotatedAt: Date | null;
  ipAddress: string;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokeReason | null;

  /** Rebuilds a session from stored state. Use `Session.start` for a new login. */
  constructor(props: SessionProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.deviceName = props.deviceName;
    this.createdAt = props.createdAt;
    this.refreshTokenHash = props.refreshTokenHash;
    this.previousRefreshTokenHash = props.previousRefreshTokenHash;
    this.rotatedAt = props.rotatedAt;
    this.ipAddress = props.ipAddress;
    this.lastUsedAt = props.lastUsedAt;
    this.expiresAt = props.expiresAt;
    this.revokedAt = props.revokedAt;
    this.revokedReason = props.revokedReason;
  }

  static start(params: {
    id: string;
    userId: string;
    refreshTokenHash: string;
    userAgent: string;
    ipAddress: string;
    now: Date;
    refreshTtlSeconds: number;
    absoluteTtlSeconds: number;
  }): Session {
    return new Session({
      id: params.id,
      userId: params.userId,
      refreshTokenHash: params.refreshTokenHash,
      previousRefreshTokenHash: null,
      rotatedAt: null,
      // The User-Agent as-is (truncated), for the owner to recognise the device
      deviceName:
        Session.withoutControlCharacters(params.userAgent)
          .trim()
          .slice(0, DEVICE_NAME_MAX_LENGTH) || UNKNOWN_DEVICE,
      ipAddress: params.ipAddress.slice(0, IP_ADDRESS_MAX_LENGTH),
      lastUsedAt: params.now,
      createdAt: params.now,
      expiresAt: Session.expiryFor({
        createdAt: params.now,
        now: params.now,
        refreshTtlSeconds: params.refreshTtlSeconds,
        absoluteTtlSeconds: params.absoluteTtlSeconds,
      }),
      revokedAt: null,
      revokedReason: null,
    });
  }

  /** Swaps in a new refresh token; the replaced one is kept to detect reuse. */
  rotate(params: {
    newRefreshTokenHash: string;
    ipAddress: string;
    now: Date;
    refreshTtlSeconds: number;
    absoluteTtlSeconds: number;
  }): void {
    this.previousRefreshTokenHash = this.refreshTokenHash;
    this.refreshTokenHash = params.newRefreshTokenHash;
    this.rotatedAt = params.now;
    this.ipAddress = params.ipAddress.slice(0, IP_ADDRESS_MAX_LENGTH);
    this.lastUsedAt = params.now;
    // Every refresh extends the session, but never past its absolute lifetime
    this.expiresAt = Session.expiryFor({
      createdAt: this.createdAt,
      now: params.now,
      refreshTtlSeconds: params.refreshTtlSeconds,
      absoluteTtlSeconds: params.absoluteTtlSeconds,
    });
  }

  revoke(reason: SessionRevokeReason, now: Date): void {
    this.revokedAt = now;
    this.revokedReason = reason;
  }

  isActive(now: Date): boolean {
    return this.revokedAt === null && this.expiresAt.getTime() > now.getTime();
  }

  /** True when the last rotation happened less than `graceSeconds` ago. */
  isWithinGrace(now: Date, graceSeconds: number): boolean {
    return (
      this.rotatedAt !== null &&
      now.getTime() - this.rotatedAt.getTime() < graceSeconds * 1000
    );
  }

  // The User-Agent is client-controlled text that is stored and shown back (and
  // can end up in logs), so line breaks and other control characters are dropped.
  private static withoutControlCharacters(value: string): string {
    return Array.from(value)
      .filter((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code >= 0x20 && code !== 0x7f;
      })
      .join('');
  }

  /**
   * A session lasts `refreshTtlSeconds` from its latest use (sliding), but never
   * beyond `absoluteTtlSeconds` after it was created: past that the user has to
   * log in again however active the session is. Expiry is the only thing the
   * repository's "live" filter looks at, so folding the cap in here enforces it
   * everywhere.
   */
  private static expiryFor(params: {
    createdAt: Date;
    now: Date;
    refreshTtlSeconds: number;
    absoluteTtlSeconds: number;
  }): Date {
    const sliding = params.now.getTime() + params.refreshTtlSeconds * 1000;
    const cap = params.createdAt.getTime() + params.absoluteTtlSeconds * 1000;
    return new Date(Math.min(sliding, cap));
  }
}
