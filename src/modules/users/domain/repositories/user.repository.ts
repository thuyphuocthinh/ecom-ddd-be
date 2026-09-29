import { User } from '../entities/user.entity.js';
import { CredentialProvider } from '@prisma/client';

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByCredential(
    provider: CredentialProvider,
    identifier: string,
  ): Promise<User | null>;
  save(user: User): Promise<void>;
}
