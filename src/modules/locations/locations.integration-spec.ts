import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@/core/index.js';
import { LocationsService } from './locations.service.js';

const SEED_FILE = join(
  process.cwd(),
  'scripts',
  'seed-administrative-units.sql',
);

describe('LocationsService (Integration)', () => {
  let service: LocationsService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LocationsService, PrismaService],
    }).compile();
    service = module.get(LocationsService);
    prisma = module.get(PrismaService);
  });

  const clear = async () => {
    await prisma.ward.deleteMany();
    await prisma.province.deleteMany();
  };

  beforeEach(clear);

  afterAll(async () => {
    await clear(); // the other tests do not need these tables, leave them empty
    await prisma.$disconnect();
  });

  describe('with a few rows', () => {
    beforeEach(async () => {
      await prisma.province.createMany({
        data: [
          { code: '01', name: 'Hà Nội', type: 'CITY' },
          { code: '96', name: 'Cà Mau', type: 'PROVINCE' },
          { code: '48', name: 'Đà Nẵng', type: 'CITY' },
        ],
      });
      await prisma.ward.createMany({
        data: [
          { code: '00004', provinceCode: '01', name: 'Ba Đình', type: 'WARD' },
          { code: '00005', provinceCode: '01', name: 'Ba Vì', type: 'COMMUNE' },
          {
            code: '31000',
            provinceCode: '96',
            name: 'Năm Căn',
            type: 'COMMUNE',
          },
        ],
      });
    });

    it('lists the provinces in Vietnamese alphabet order', async () => {
      const provinces = await service.listProvinces();

      expect(provinces.map((p) => p.name)).toEqual([
        'Cà Mau',
        'Đà Nẵng',
        'Hà Nội',
      ]);
    });

    it('lists only the wards of the asked province (AC-2)', async () => {
      const wards = await service.listWards('01');

      expect(wards.map((w) => w.fullName)).toEqual([
        'Phường Ba Đình',
        'Xã Ba Vì',
      ]);
    });

    it('gives an empty list for a province without wards, and LOC-001 for one that does not exist', async () => {
      expect(await service.listWards('48')).toEqual([]);
      await expect(service.listWards('99')).rejects.toMatchObject({
        code: 'LOC-001',
      });
      await expect(service.listWards("01' OR '1'='1")).rejects.toMatchObject({
        code: 'LOC-001',
      });
    });

    it('gives a ward with its province, and LOC-002 for a code that does not exist (AC-6)', async () => {
      const ward = await service.getWard('31000');

      expect(ward.fullName).toBe('Xã Năm Căn');
      expect(ward.province).toMatchObject({
        code: '96',
        fullName: 'Tỉnh Cà Mau',
      });
      await expect(service.getWard('12345')).rejects.toMatchObject({
        code: 'LOC-002',
      });
    });
  });

  describe('what the database refuses (AC-7)', () => {
    beforeEach(async () => {
      await prisma.province.create({
        data: { code: '01', name: 'Hà Nội', type: 'CITY' },
      });
    });

    it('refuses a ward of a province that does not exist', async () => {
      await expect(
        prisma.ward.create({
          data: { code: '00001', provinceCode: '77', name: 'X', type: 'WARD' },
        }),
      ).rejects.toThrow();
    });

    it('refuses to delete a province that still has wards', async () => {
      await prisma.ward.create({
        data: {
          code: '00001',
          provinceCode: '01',
          name: 'Ba Đình',
          type: 'WARD',
        },
      });

      await expect(
        prisma.province.delete({ where: { code: '01' } }),
      ).rejects.toThrow();
    });

    it('refuses a code that is not the right number of digits, and an empty name', async () => {
      const badProvince = (code: string, name = 'Tên') =>
        prisma.province.create({ data: { code, name, type: 'PROVINCE' } });
      const badWard = (code: string, name = 'Tên') =>
        prisma.ward.create({
          data: { code, provinceCode: '01', name, type: 'WARD' },
        });

      await expect(badProvince('1')).rejects.toThrow();
      await expect(badProvince('123')).rejects.toThrow();
      await expect(badProvince('ab')).rejects.toThrow();
      await expect(badProvince('02', '   ')).rejects.toThrow();
      await expect(badWard('1234')).rejects.toThrow();
      await expect(badWard('123456')).rejects.toThrow();
      await expect(badWard('abcde')).rejects.toThrow();
      await expect(badWard('00001', '')).rejects.toThrow();
      await expect(badWard('00001', '  ')).rejects.toThrow();
    });
  });

  describe('the seed file scripts/seed-administrative-units.sql (AC-4, AC-5)', () => {
    // One connection that runs the whole file in one go (Prisma sends one statement at a time)
    const runSeedFile = async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await client.query(readFileSync(SEED_FILE, 'utf8'));
      } finally {
        await client.end();
      }
    };

    it('fills 34 provinces and 3,321 wards in the right shape', async () => {
      await runSeedFile();

      expect(await prisma.province.count()).toBe(34);
      expect(await prisma.province.count({ where: { type: 'CITY' } })).toBe(6);
      expect(
        (await prisma.province.findMany({ where: { type: 'CITY' } }))
          .map((p) => p.code)
          .sort(),
      ).toEqual(['01', '31', '46', '48', '79', '92']);
      expect(await prisma.ward.count()).toBe(3321);
      expect(await prisma.ward.count({ where: { type: 'WARD' } })).toBe(687);
      expect(await prisma.ward.count({ where: { type: 'COMMUNE' } })).toBe(
        2621,
      );
      expect(await prisma.ward.count({ where: { type: 'SPECIAL_ZONE' } })).toBe(
        13,
      );

      // every province has wards, and every ward has its province (the foreign key makes the second sure)
      const provincesWithoutWards = await prisma.province.count({
        where: { wards: { none: {} } },
      });
      expect(provincesWithoutWards).toBe(0);

      // names are stored without the kind
      const withKind = await prisma.ward.count({
        where: {
          OR: [
            { name: { startsWith: 'Phường ' } },
            { name: { startsWith: 'Xã ' } },
            { name: { startsWith: 'Đặc khu ' } },
          ],
        },
      });
      expect(withKind).toBe(0);
      const provinceWithKind = await prisma.province.count({
        where: {
          OR: [
            { name: { startsWith: 'Tỉnh ' } },
            { name: { startsWith: 'Thành phố ' } },
          ],
        },
      });
      expect(provinceWithKind).toBe(0);

      // known examples
      expect(await service.getWard('00004')).toMatchObject({
        fullName: 'Phường Ba Đình',
        province: { code: '01', fullName: 'Thành phố Hà Nội' },
      });
      const province79 = (await service.listProvinces()).find(
        (p) => p.code === '79',
      );
      expect(province79?.fullName).toBe('Thành phố Hồ Chí Minh');
      // Quảng Ninh, Bắc Ninh and Đồng Nai are provinces, although some sources call them cities
      const types = Object.fromEntries(
        (await service.listProvinces()).map((p) => [p.name, p.type]),
      );
      expect(types['Quảng Ninh']).toBe('PROVINCE');
      expect(types['Bắc Ninh']).toBe('PROVINCE');
      expect(types['Đồng Nai']).toBe('PROVINCE');
    });

    it('can run again: no new rows, and a changed row goes back to what the file says', async () => {
      await runSeedFile();
      await prisma.ward.update({
        where: { code: '00004' },
        data: { name: 'SAI' },
      });
      await prisma.province.update({
        where: { code: '79' },
        data: { type: 'PROVINCE' },
      });

      await runSeedFile();

      expect(await prisma.province.count()).toBe(34);
      expect(await prisma.ward.count()).toBe(3321);
      expect(
        (await prisma.ward.findUnique({ where: { code: '00004' } }))?.name,
      ).toBe('Ba Đình');
      expect(
        (await prisma.province.findUnique({ where: { code: '79' } }))?.type,
      ).toBe('CITY');
    });

    it('lists the wards of the biggest province without losing any', async () => {
      await runSeedFile();

      const wards = await service.listWards('79'); // Hồ Chí Minh
      expect(wards.length).toBe(168);
      expect(new Set(wards.map((w) => w.code)).size).toBe(168);
    });
  });
});
