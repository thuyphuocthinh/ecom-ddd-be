import { Injectable } from '@nestjs/common';
import { ProvinceType, WardType } from '@prisma/client';
import {
  DomainException,
  LocationErrorCodes,
  PrismaService,
} from '@/core/index.js';
import {
  ProvinceDto,
  WardDto,
  WardWithProvinceDto,
} from './dto/location-response.dto.js';

// What goes in front of a name to make the full name ("Phường" + "Ba Đình")
const PROVINCE_KIND: Record<ProvinceType, string> = {
  CITY: 'Thành phố',
  PROVINCE: 'Tỉnh',
};
const WARD_KIND: Record<WardType, string> = {
  WARD: 'Phường',
  COMMUNE: 'Xã',
  SPECIAL_ZONE: 'Đặc khu',
};

// Vietnamese alphabet order (Đ after D, tone marks as in a dictionary). The ordering of the
// database depends on how it was set up, so the names are sorted here.
const collator = new Intl.Collator('vi');
const byName = (a: { name: string }, b: { name: string }) =>
  collator.compare(a.name, b.name);

type ProvinceRow = { code: string; name: string; type: ProvinceType };
type WardRow = { code: string; name: string; type: WardType };

const toProvince = (row: ProvinceRow): ProvinceDto => ({
  code: row.code,
  name: row.name,
  fullName: `${PROVINCE_KIND[row.type]} ${row.name}`,
  type: row.type,
});
const toWard = (row: WardRow): WardDto => ({
  code: row.code,
  name: row.name,
  fullName: `${WARD_KIND[row.type]} ${row.name}`,
  type: row.type,
});

/**
 * Looks up the administrative units (provinces and the wards under them). Read-only reference
 * data filled by scripts/seed-administrative-units.sql. Other modules use it to check that a ward
 * code is real and to find its province.
 */
@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async listProvinces(): Promise<ProvinceDto[]> {
    const rows = await this.prisma.province.findMany();
    return rows.sort(byName).map(toProvince);
  }

  /** All wards of a province; LOC-001 when there is no such province. */
  async listWards(provinceCode: string): Promise<WardDto[]> {
    const province = await this.prisma.province.findUnique({
      where: { code: provinceCode },
      include: { wards: true },
    });
    if (!province) {
      throw new DomainException(LocationErrorCodes.PROVINCE_NOT_FOUND);
    }
    return province.wards.sort(byName).map(toWard);
  }

  /** One ward with its province; LOC-002 when there is no such ward. */
  async getWard(wardCode: string): Promise<WardWithProvinceDto> {
    const ward = await this.prisma.ward.findUnique({
      where: { code: wardCode },
      include: { province: true },
    });
    if (!ward) throw new DomainException(LocationErrorCodes.WARD_NOT_FOUND);
    return { ...toWard(ward), province: toProvince(ward.province) };
  }
}
