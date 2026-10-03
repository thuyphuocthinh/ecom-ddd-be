import { User } from '../entities/user.entity.js';
import { CredentialProvider } from '@prisma/client';

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByCredential(
    provider: CredentialProvider,
    identifier: string,
  ): Promise<User | null>;
  save(user: User): Promise<void>;
  /**
   * Changes only the display name (the other columns and the credentials are not touched, so a
   * password change made at the same moment is not undone). False when the user does not exist.
   */
  updateDisplayName(userId: string, displayName: string): Promise<boolean>;
  /** Changes only the avatar address; null removes it. False when the user does not exist. */
  setAvatarUrl(userId: string, avatarUrl: string | null): Promise<boolean>;
}
