import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AddressErrorCodes,
  PrismaService,
  UserErrorCodes,
} from '@/core/index.js';
import {
  ADDRESS_MAX_PER_USER,
  Address,
  AddressDomainException,
  UserDomainException,
} from '../../domain/index.js';
import type { IAddressRepository } from '../../domain/index.js';
import { AddressMapper } from './mappers/address.mapper.js';

@Injectable()
export class PrismaAddressRepository implements IAddressRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` in a transaction that first takes a pessimistic lock on the user's row. Two
   * requests of the same user wait for each other there, so counting the addresses and changing
   * the default are never done on a half-finished state; other users are not held up.
   * FOR NO KEY UPDATE (not FOR UPDATE) because it does not hold back inserts that only point at
   * the user, such as a new login session.
   */
  private inUserLock<T>(
    userId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
      if (locked.length === 0) {
        throw new UserDomainException(UserErrorCodes.USER_NOT_FOUND);
      }
      return work(tx);
    });
  }

  async list(userId: string): Promise<Address[]> {
    const rows = await this.prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(AddressMapper.toDomain);
  }

  async findOwned(userId: string, id: string): Promise<Address | null> {
    const row = await this.prisma.address.findFirst({ where: { id, userId } });
    return row ? AddressMapper.toDomain(row) : null;
  }

  add(
    userId: string,
    address: Address,
    makeDefault: boolean,
  ): Promise<Address> {
    return this.inUserLock(userId, async (tx) => {
      const count = await tx.address.count({ where: { userId } });
      if (count >= ADDRESS_MAX_PER_USER) {
        throw new AddressDomainException(
          AddressErrorCodes.ADDRESS_LIMIT_REACHED,
        );
      }
      const isDefault = makeDefault || count === 0;
      if (isDefault) {
        // The old default stops being the default BEFORE the new row is written: the partial
        // unique index checks every statement, so two defaults must never exist, even for a moment
        await tx.address.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      const row = await tx.address.create({
        data: {
          id: address.id,
          userId,
          recipientName: address.recipientName,
          phone: address.phone,
          provinceCode: address.provinceCode,
          provinceName: address.provinceName,
          wardCode: address.wardCode,
          wardName: address.wardName,
          street: address.street,
          label: address.label,
          isDefault,
        },
      });
      return AddressMapper.toDomain(row);
    });
  }

  update(userId: string, address: Address): Promise<Address | null> {
    return this.inUserLock(userId, async (tx) => {
      const { count } = await tx.address.updateMany({
        where: { id: address.id, userId },
        data: {
          recipientName: address.recipientName,
          phone: address.phone,
          provinceCode: address.provinceCode,
          provinceName: address.provinceName,
          wardCode: address.wardCode,
          wardName: address.wardName,
          street: address.street,
          label: address.label,
        },
      });
      if (count === 0) return null;
      const row = await tx.address.findFirst({
        where: { id: address.id, userId },
      });
      return row ? AddressMapper.toDomain(row) : null;
    });
  }

  setDefault(userId: string, id: string): Promise<Address | null> {
    return this.inUserLock(userId, async (tx) => {
      const row = await tx.address.findFirst({ where: { id, userId } });
      if (!row) return null;
      if (row.isDefault) return AddressMapper.toDomain(row);
      // Old default off first, then the new one on (see add)
      await tx.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      const updated = await tx.address.update({
        where: { id },
        data: { isDefault: true },
      });
      return AddressMapper.toDomain(updated);
    });
  }

  remove(userId: string, id: string): Promise<boolean> {
    return this.inUserLock(userId, async (tx) => {
      const row = await tx.address.findFirst({ where: { id, userId } });
      if (!row) return false;
      await tx.address.delete({ where: { id } });
      if (row.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (next) {
          await tx.address.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
        }
      }
      return true;
    });
  }
}
