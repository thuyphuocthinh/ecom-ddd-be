import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/index.js';
import type {
  ChangePasswordParams,
  ChangePasswordResult,
  IPasswordRepository,
} from '../../domain/index.js';

@Injectable()
export class PrismaPasswordRepository implements IPasswordRepository {
  constructor(private readonly prisma: PrismaService) {}

  async changePassword(
    params: ChangePasswordParams,
  ): Promise<ChangePasswordResult> {
    const {
      userId,
      credentialId,
      newHash,
      expectedOldHash,
      reason,
      exceptSessionId,
      now,
    } = params;

    return this.prisma.$transaction(async (tx) => {
      // Only that credential, and only if its hash is still the one the caller checked
      const updated = await tx.userCredential.updateMany({
        where: {
          id: credentialId,
          userId,
          ...(expectedOldHash !== undefined ? { secret: expectedOldHash } : {}),
        },
        data: { secret: newHash },
      });
      if (updated.count === 0) {
        return { changed: false, revokedSessionIds: [] };
      }

      // One UPDATE closes every live session. Listing them first and closing them afterwards
      // would let a session started in between slip through, still open.
      await tx.session.updateMany({
        where: {
          userId,
          revokedAt: null,
          expiresAt: { gt: now },
          ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
        },
        data: { revokedAt: now, revokedReason: reason },
      });
      // The sessions closed just now are the ones carrying exactly this time and reason
      const closed = await tx.session.findMany({
        where: { userId, revokedAt: now, revokedReason: reason },
        select: { id: true },
      });
      return {
        changed: true,
        revokedSessionIds: closed.map((row) => row.id),
      };
    });
  }
}
