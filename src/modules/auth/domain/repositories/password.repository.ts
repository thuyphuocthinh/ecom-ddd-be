import type { SessionRevokeReason } from '../entities/session.entity.js';

export interface ChangePasswordParams {
  userId: string;
  /** The email credential whose hash is replaced (looked up by the caller, never guessed here). */
  credentialId: string;
  /** The argon2 hash of the new password. */
  newHash: string;
  /**
   * When given, the password is only replaced if the stored hash is still exactly this one.
   * That is how a change that was checked against the old password refuses to overwrite a
   * password somebody else set in the meantime.
   */
  expectedOldHash?: string;
  /** Why the sessions are closed. */
  reason: SessionRevokeReason;
  /** A session to keep open (the one the user is changing the password from). */
  exceptSessionId?: string;
  now: Date;
}

export interface ChangePasswordResult {
  /** False when nothing was written: no email credential, or the stored hash was not `expectedOldHash`. */
  changed: boolean;
  /** Ids of the sessions that were closed, so their access tokens can be refused at once. */
  revokedSessionIds: string[];
}

/**
 * Changes a user's password and closes their sessions as ONE all-or-nothing step. Doing them
 * separately could leave the new password in place with stolen sessions still alive.
 */
export interface IPasswordRepository {
  changePassword(params: ChangePasswordParams): Promise<ChangePasswordResult>;
}
