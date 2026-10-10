import { LocationsService } from './locations.service.js';
import type { PrismaService } from '@/core/index.js';

const makeService = (prisma: object) =>
  new LocationsService(prisma as unknown as PrismaService);

describe('LocationsService', () => {
  describe('listProvinces', () => {
    it('puts the kind in front of the name and sorts in Vietnamese alphabet order', async () => {
      const service = makeService({
        province: {
          findMany: async () => [
            { code: '48', name: 'Đà Nẵng', type: 'CITY' },
            { code: '68', name: 'Lâm Đồng', type: 'PROVINCE' },
            { code: '11', name: 'Điện Biên', type: 'PROVINCE' },
            { code: '96', name: 'Cà Mau', type: 'PROVINCE' },
            { code: '01', name: 'Hà Nội', type: 'CITY' },
          ],
        },
      });

      const provinces = await service.listProvinces();

      // In the Vietnamese alphabet Đ comes right after D, so the Đ names are after C and before H
      expect(provinces.map((p) => p.name)).toEqual([
        'Cà Mau',
        'Đà Nẵng',
        'Điện Biên',
        'Hà Nội',
        'Lâm Đồng',
      ]);
      expect(provinces.map((p) => p.fullName)).toEqual([
        'Tỉnh Cà Mau',
        'Thành phố Đà Nẵng',
        'Tỉnh Điện Biên',
        'Thành phố Hà Nội',
        'Tỉnh Lâm Đồng',
      ]);
    });
  });

  describe('listWards', () => {
    it('builds the full name for each kind of ward and sorts them', async () => {
      const service = makeService({
        province: {
          findUnique: async () => ({
            code: '01',
            name: 'Hà Nội',
            type: 'CITY',
            wards: [
              { code: '00003', name: 'Xuân Mai', type: 'COMMUNE' },
              { code: '00002', name: 'Cô Tô', type: 'SPECIAL_ZONE' },
              { code: '00001', name: 'Ba Đình', type: 'WARD' },
            ],
          }),
        },
      });

      const wards = await service.listWards('01');

      expect(wards).toEqual([
        {
          code: '00001',
          name: 'Ba Đình',
          fullName: 'Phường Ba Đình',
          type: 'WARD',
        },
        {
          code: '00002',
          name: 'Cô Tô',
          fullName: 'Đặc khu Cô Tô',
          type: 'SPECIAL_ZONE',
        },
        {
          code: '00003',
          name: 'Xuân Mai',
          fullName: 'Xã Xuân Mai',
          type: 'COMMUNE',
        },
      ]);
    });

    it('fails with LOC-001 when the province does not exist', async () => {
      const service = makeService({
        province: { findUnique: async () => null },
      });

      await expect(service.listWards('99')).rejects.toMatchObject({
        code: 'LOC-001',
        status: 404,
      });
    });
  });

  describe('getWard', () => {
    it('returns the ward with its province', async () => {
      const service = makeService({
        ward: {
          findUnique: async () => ({
            code: '00004',
            name: 'Ba Đình',
            type: 'WARD',
            province: { code: '01', name: 'Hà Nội', type: 'CITY' },
          }),
        },
      });

      expect(await service.getWard('00004')).toEqual({
        code: '00004',
        name: 'Ba Đình',
        fullName: 'Phường Ba Đình',
        type: 'WARD',
        province: {
          code: '01',
          name: 'Hà Nội',
          fullName: 'Thành phố Hà Nội',
          type: 'CITY',
        },
      });
    });

    it('fails with LOC-002 when the ward does not exist', async () => {
      const service = makeService({ ward: { findUnique: async () => null } });

      await expect(service.getWard('99999')).rejects.toMatchObject({
        code: 'LOC-002',
        status: 404,
      });
    });
  });
});
