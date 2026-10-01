import type {
  Session,
  SessionRevokeReason,
} from '../entities/session.entity.js';

export interface ISessionRepository {
  /** Inserts a newly started session. */
  save(session: Session): Promise<void>;

  /** The live session whose current refresh token has this hash. */
  findActiveByRefreshHash(hash: string, now: Date): Promise<Session | null>;

  /** The live session whose most recently replaced refresh token has this hash. */
  findActiveByPreviousHash(hash: string, now: Date): Promise<Session | null>;

  /** A user's live sessions, most recently used first. */
  findActiveByUser(userId: string, now: Date): Promise<Session[]>;

  /**
   * Persists a rotation done on `session` (via `Session.rotate`) only if the
   * stored refresh token is still `expectedRefreshHash` and the session is
   * still live. Atomic: of several concurrent rotations of the same token,
   * exactly one returns `true`.
   */
  rotate(
    session: Session,
    expectedRefreshHash: string,
    now: Date,
  ): Promise<boolean>;

  /** Revokes one of the user's sessions. `false` when nothing was live to revoke. */
  revoke(
    id: string,
    userId: string,
    reason: SessionRevokeReason,
    now: Date,
  ): Promise<boolean>;

  /** Revokes all of the user's live sessions (optionally sparing one); returns the ids revoked. */
  revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    now: Date,
    exceptId?: string,
  ): Promise<string[]>;
}
