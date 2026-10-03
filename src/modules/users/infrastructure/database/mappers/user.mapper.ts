import {
  User as PrismaUser,
  UserCredential as PrismaCredential,
} from '@prisma/client';
import { User, UserCredential } from '../../../domain/entities/user.entity.js';

type PrismaUserWithCredentials = PrismaUser & {
  credentials?: PrismaCredential[];
};

export class UserMapper {
  static toDomain(prismaUser: PrismaUserWithCredentials): User {
    const credentials =
      prismaUser.credentials?.map(
        (c) =>
          new UserCredential(
            c.id,
            c.provider,
            c.identifier,
            c.secret,
            c.createdAt,
            c.updatedAt,
          ),
      ) || [];

    return new User(
      prismaUser.id,
      prismaUser.role,
      prismaUser.displayName,
      prismaUser.avatarUrl,
      prismaUser.createdAt,
      prismaUser.updatedAt,
      credentials,
      prismaUser.status,
    );
  }

  static toPersistence(user: User): PrismaUserWithCredentials {
    return {
      id: user.id,
      role: user.role,
      status: user.status,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      credentials: user.credentials.map((c) => ({
        id: c.id,
        userId: user.id,
        provider: c.provider,
        identifier: c.identifier,
        secret: c.secret,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    };
  }
}
