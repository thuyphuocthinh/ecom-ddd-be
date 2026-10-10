import type { Address as PrismaAddress } from '@prisma/client';
import { Address } from '../../../domain/entities/address.entity.js';

export class AddressMapper {
  static toDomain(row: PrismaAddress): Address {
    return Address.restore({
      id: row.id,
      userId: row.userId,
      recipientName: row.recipientName,
      phone: row.phone,
      provinceCode: row.provinceCode,
      provinceName: row.provinceName,
      wardCode: row.wardCode,
      wardName: row.wardName,
      street: row.street,
      label: row.label,
      isDefault: row.isDefault,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
