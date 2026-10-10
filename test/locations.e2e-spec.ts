import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
} from './../src/core/index.js';
import { ClsService } from 'nestjs-cls';

// No guard is switched off here on purpose: the endpoints are public (AC-3)
const BASE = '/api/v1/locations';

describe('LocationsController (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    const clsService = app.get(ClsService);
    app.useGlobalFilters(new AllExceptionsFilter(clsService));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.ward.deleteMany();
    await prisma.province.deleteMany();
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
        { code: '31000', provinceCode: '96', name: 'Năm Căn', type: 'COMMUNE' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.ward.deleteMany();
    await prisma.province.deleteMany();
    await app.close();
  });

  describe('GET /locations/provinces', () => {
    it('answers without a token, with the provinces in Vietnamese order (AC-1, AC-3)', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/provinces`)
        .expect(200);

      expect(res.body.data).toEqual([
        {
          code: '96',
          name: 'Cà Mau',
          fullName: 'Tỉnh Cà Mau',
          type: 'PROVINCE',
        },
        {
          code: '48',
          name: 'Đà Nẵng',
          fullName: 'Thành phố Đà Nẵng',
          type: 'CITY',
        },
        {
          code: '01',
          name: 'Hà Nội',
          fullName: 'Thành phố Hà Nội',
          type: 'CITY',
        },
      ]);
      expect(res.headers['cache-control']).toBe('public, max-age=86400');
      expect(JSON.stringify(res.body)).not.toMatch(/district|huyện|quận/i);
    });
  });

  describe('GET /locations/provinces/:code/wards', () => {
    it('gives the wards of that province only (AC-2)', async () => {
      const res = await request(app.getHttpServer())
        .get(`${BASE}/provinces/01/wards`)
        .expect(200);

      expect(res.body.data).toEqual([
        {
          code: '00004',
          name: 'Ba Đình',
          fullName: 'Phường Ba Đình',
          type: 'WARD',
        },
        { code: '00005', name: 'Ba Vì', fullName: 'Xã Ba Vì', type: 'COMMUNE' },
      ]);
      expect(res.headers['cache-control']).toBe('public, max-age=86400');
    });

    it('answers 404 LOC-001, and does not let the answer be cached, for a province that does not exist or is badly written', async () => {
      for (const code of ['99', '1', 'abc', '01%27%20OR%20%271%27=%271']) {
        const res = await request(app.getHttpServer())
          .get(`${BASE}/provinces/${code}/wards`)
          .expect(404);

        expect(res.body.code).toBe('LOC-001');
        expect(res.headers['cache-control']).toBeUndefined();
      }
    });
  });

  it('only reads: POST, PUT, PATCH and DELETE are not routes (AC-3)', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app.getHttpServer())[method](
        `${BASE}/provinces`,
      );
      expect(res.status).toBe(404);
    }
    expect(await prisma.province.count()).toBe(3);
  });
});
