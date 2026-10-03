import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, UserErrorCodes } from '@/core/index.js';
import {
  IUserRepository,
  User,
  UserDomainException,
} from '../../domain/index.js';
import { UserMapper } from './mappers/user.mapper.js';
import { CredentialProvider, Prisma, UserStatus } from '@prisma/client';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class PrismaUserRepository implements IUserRepository {
  private readonly logger = new Logger(PrismaUserRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<User | null> {
    this.logger.debug(`Finding user by ID: ${id}`);
    const prismaUser = await this.prisma.user.findUnique({
      where: { id },
      include: { credentials: true },
    });
    return prismaUser ? UserMapper.toDomain(prismaUser) : null;
  }

  async findByCredential(
    provider: CredentialProvider,
    identifier: string,
  ): Promise<User | null> {
    // identifier is an email/phone — PII, kept out of the logs
    this.logger.debug(`Finding user by ${provider} credential`);
    const credential = await this.prisma.userCredential.findUnique({
      where: {
        provider_identifier: {
          provider,
          identifier,
        },
      },
      include: {
        user: {
          include: {
            credentials: true,
          },
        },
      },
    });
    return credential ? UserMapper.toDomain(credential.user) : null;
  }

  async updateDisplayName(
    userId: string,
    displayName: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId },
      data: { displayName },
    });
    return count > 0;
  }

  async setAvatarUrl(
    userId: string,
    avatarUrl: string | null,
  ): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId },
      data: { avatarUrl },
    });
    return count > 0;
  }

  async setStatus(userId: string, status: UserStatus): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId },
      data: { status },
    });
    return count > 0;
  }

  async findStatus(userId: string): Promise<UserStatus | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    return row?.status ?? null;
  }

  async save(user: User): Promise<void> {
    this.logger.debug(`Saving user: ${user.id}`);
    const data = UserMapper.toPersistence(user);

    try {
      await this.saveInTransaction(data);
    } catch (error) {
      // Two concurrent registrations for one email both pass the handler's
      // existence check; the unique (provider, identifier) index is what actually
      // stops the second one, so report it as the same conflict, not a 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        throw new UserDomainException(
          UserErrorCodes.EMAIL_ALREADY_EXISTS,
          'Email is already registered',
        );
      }
      throw error;
    }
  }

  private async saveInTransaction(
    data: ReturnType<typeof UserMapper.toPersistence>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 1. Upsert User
      await tx.user.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          role: data.role,
          status: data.status,
          displayName: data.displayName,
          avatarUrl: data.avatarUrl,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        },
        update: {
          role: data.role,
          displayName: data.displayName,
          avatarUrl: data.avatarUrl,
          updatedAt: data.updatedAt,
        },
      });

      // 2. Upsert Credentials if any
      if (data.credentials && data.credentials.length > 0) {
        for (const cred of data.credentials) {
          await tx.userCredential.upsert({
            where: { id: cred.id },
            create: cred,
            update: cred,
          });
        }
      }
    });
  }
}
