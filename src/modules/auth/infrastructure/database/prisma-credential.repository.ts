import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core/index.js';
import type {
  ICredentialRepository,
  LinkGoogleResult,
  UnlinkGoogleResult,
} from '../../domain/index.js';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const RAW_QUERY_FAILED = 'P2010';
const POSTGRES_UNIQUE_VIOLATION = '23505';
// The two unique indexes that can refuse a Google credential
const SUB_INDEX = 'UserCredential_provider_identifier_key';
const ONE_PER_USER_INDEX = 'UserCredential_userId_google_key';

@Injectable()
export class PrismaCredentialRepository implements ICredentialRepository {
  constructor(private readonly prisma: PrismaService) {}

  async linkGoogle(userId: string, sub: string): Promise<LinkGoogleResult> {
    try {
      // The NOT EXISTS is the quick answer; the unique index on (userId) for Google credentials is
      // what really guarantees it when two requests run at the same moment
      const inserted = await this.prisma.$executeRaw`
        INSERT INTO "UserCredential" ("id", "userId", "provider", "identifier", "secret", "updatedAt")
        SELECT ${randomUUID()}, ${userId}, 'GOOGLE'::"CredentialProvider", ${sub}, NULL, NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM "UserCredential"
          WHERE "userId" = ${userId} AND "provider" = 'GOOGLE'::"CredentialProvider"
        )`;
      return inserted === 1 ? 'LINKED' : 'USER_HAS_GOOGLE';
    } catch (error) {
      const index = this.violatedIndex(error);
      if (index === ONE_PER_USER_INDEX) return 'USER_HAS_GOOGLE';
      // (provider, identifier) is unique: this Google account is linked to somebody already
      if (index !== null) return 'SUB_TAKEN';
      throw error;
    }
  }

  async unlinkGoogle(userId: string): Promise<UnlinkGoogleResult> {
    // One DELETE that only happens while the user still has an email password to log in with,
    // so two requests at the same time cannot remove every way in
    const removed = await this.prisma.$executeRaw`
      DELETE FROM "UserCredential"
      WHERE "userId" = ${userId}
        AND "provider" = 'GOOGLE'::"CredentialProvider"
        AND EXISTS (
          SELECT 1 FROM "UserCredential"
          WHERE "userId" = ${userId}
            AND "provider" = 'EMAIL'::"CredentialProvider"
            AND "secret" IS NOT NULL
        )`;
    if (removed > 0) return 'UNLINKED';

    const stillLinked = await this.prisma.userCredential.count({
      where: { userId, provider: 'GOOGLE' },
    });
    return stillLinked > 0 ? 'LAST_METHOD' : 'NOT_LINKED';
  }

  async fillProfileIfEmpty(
    userId: string,
    profile: { displayName: string | null; avatarUrl: string | null },
  ): Promise<void> {
    if (profile.displayName) {
      await this.prisma.user.updateMany({
        where: { id: userId, displayName: null },
        data: { displayName: profile.displayName },
      });
    }
    if (profile.avatarUrl) {
      await this.prisma.user.updateMany({
        where: { id: userId, avatarUrl: null },
        data: { avatarUrl: profile.avatarUrl },
      });
    }
  }

  /**
   * The name of the unique index a database error refers to, or null when it is not a unique
   * violation. From a plain Prisma call that is P2002; from a raw query it arrives as P2010 with
   * the database code 23505 and the index name buried in the driver error.
   */
  private violatedIndex(error: unknown): string | null {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
    const meta = error.meta as
      | {
          driverAdapterError?: {
            cause?: {
              originalCode?: string;
              constraint?: { index?: string };
            };
          };
        }
      | undefined;
    const cause = meta?.driverAdapterError?.cause;
    if (
      error.code === RAW_QUERY_FAILED &&
      cause?.originalCode === POSTGRES_UNIQUE_VIOLATION
    ) {
      return cause.constraint?.index ?? SUB_INDEX;
    }
    if (error.code === UNIQUE_CONSTRAINT_VIOLATION) {
      return SUB_INDEX;
    }
    return null;
  }
}
