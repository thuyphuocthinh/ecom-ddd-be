export type LinkGoogleResult =
  | 'LINKED'
  /** This Google account is already linked to somebody (maybe someone else). */
  | 'SUB_TAKEN'
  /** This user already has a Google account linked. */
  | 'USER_HAS_GOOGLE';

export type UnlinkGoogleResult =
  | 'UNLINKED'
  | 'NOT_LINKED'
  /** Google is the only way this user can log in, so it cannot be removed. */
  | 'LAST_METHOD';

/**
 * Changes to a user's login methods that must be decided by the database in one step. They
 * never rewrite the whole user (a stale copy could undo a password change made meanwhile).
 */
export interface ICredentialRepository {
  /** Adds a Google credential to the user, unless one exists or the Google account is taken. */
  linkGoogle(userId: string, sub: string): Promise<LinkGoogleResult>;

  /** Removes the Google credential, but only if the user still has a password to log in with. */
  unlinkGoogle(userId: string): Promise<UnlinkGoogleResult>;

  /** Fills the display name and picture, but only where they are still empty. */
  fillProfileIfEmpty(
    userId: string,
    profile: { displayName: string | null; avatarUrl: string | null },
  ): Promise<void>;
}
