import { vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import { PrismaService } from '@/core/index.js';
import { LocationsService } from '../locations/locations.service.js';
import { PrismaAddressRepository } from './infrastructure/database/prisma-address.repository.js';
import {
  AddAddressCommand,
  AddAddressHandler,
  AddressPlaceResolver,
  GetAddressHandler,
  GetAddressQuery,
  ListAddressesHandler,
  ListAddressesQuery,
  RemoveAddressCommand,
  RemoveAddressHandler,
  SetDefaultAddressCommand,
  SetDefaultAddressHandler,
  UpdateAddressCommand,
  UpdateAddressHandler,
} from './application/index.js';
import type { AddAddressInput } from './application/index.js';
import type { Address, AddressSnapshot } from './domain/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const U1 = 'ad_user_1';
const U2 = 'ad_user_2';

const BA_DINH = '00004'; // Phường Ba Đình, Thành phố Hà Nội
const BA_VI = '00005'; // Xã Ba Vì, Thành phố Hà Nội
const HAI_CHAU = '20000'; // Phường Hải Châu, Thành phố Đà Nẵng

/** The result of a call that may fail, so many of them can be counted. */
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: any) => ({
      ok: false as const,
      code: error?.code as string,
      details: error?.details,
    }),
  );

describe('Address book (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let commands: CommandBus;
  let queries: QueryBus;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [
        PrismaService,
        LocationsService,
        AddressPlaceResolver,
        { provide: 'IAddressRepository', useClass: PrismaAddressRepository },
        AddAddressHandler,
        UpdateAddressHandler,
        RemoveAddressHandler,
        SetDefaultAddressHandler,
        ListAddressesHandler,
        GetAddressHandler,
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    commands = module.get(CommandBus);
    queries = module.get(QueryBus);
  });

  const clear = async () => {
    await prisma.address.deleteMany();
    await prisma.user.deleteMany({ where: { id: { startsWith: 'ad_' } } });
    await prisma.ward.deleteMany();
    await prisma.province.deleteMany();
  };

  beforeEach(async () => {
    await clear();
    await prisma.province.createMany({
      data: [
        { code: '01', name: 'Hà Nội', type: 'CITY' },
        { code: '48', name: 'Đà Nẵng', type: 'CITY' },
      ],
    });
    await prisma.ward.createMany({
      data: [
        { code: BA_DINH, provinceCode: '01', name: 'Ba Đình', type: 'WARD' },
        { code: BA_VI, provinceCode: '01', name: 'Ba Vì', type: 'COMMUNE' },
        {
          code: HAI_CHAU,
          provinceCode: '48',
          name: 'Hải Châu',
          type: 'WARD',
        },
      ],
    });
    await prisma.user.createMany({ data: [{ id: U1 }, { id: U2 }] });
  });

  afterAll(async () => {
    await clear();
    await module.close();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  const input = (
    overrides: Partial<AddAddressInput> = {},
  ): AddAddressInput => ({
    recipientName: 'Nguyễn Văn A',
    phone: '0912345678',
    wardCode: BA_DINH,
    street: '12 Bạch Đằng',
    ...overrides,
  });
  const add = (userId: string, overrides: Partial<AddAddressInput> = {}) =>
    commands.execute<AddAddressCommand, Address>(
      new AddAddressCommand(userId, input(overrides)),
    );
  /** Adds one and waits a moment, so the creation times of several addresses differ */
  const addSlowly = async (
    userId: string,
    overrides: Partial<AddAddressInput> = {},
  ) => {
    const address = await add(userId, overrides);
    await sleep(5);
    return address;
  };
  const list = (userId: string) =>
    queries.execute<ListAddressesQuery, Address[]>(
      new ListAddressesQuery(userId),
    );
  const defaultsOf = async (userId: string) =>
    (await list(userId)).filter((a) => a.isDefault);
  const setDefault = (userId: string, id: string) =>
    commands.execute<SetDefaultAddressCommand, Address>(
      new SetDefaultAddressCommand(userId, id),
    );
  const remove = (userId: string, id: string) =>
    commands.execute<RemoveAddressCommand, void>(
      new RemoveAddressCommand(userId, id),
    );
  const update = (
    userId: string,
    id: string,
    changes: Record<string, unknown>,
  ) =>
    commands.execute<UpdateAddressCommand, Address>(
      new UpdateAddressCommand(userId, id, changes),
    );
  const failureOf = async (promise: Promise<unknown>) => {
    const result = await settle(promise);
    if (result.ok) throw new Error('should have failed');
    return result;
  };

  // ── AC-1, AC-2 ─────────────────────────────────────────────────────────────

  describe('adding (AC-2)', () => {
    it('saves the address with the province and full names taken from the ward', async () => {
      const address = await add(U1, { label: 'Nhà' });

      expect(address).toMatchObject({
        userId: U1,
        recipientName: 'Nguyễn Văn A',
        phone: '0912345678',
        provinceCode: '01',
        provinceName: 'Thành phố Hà Nội',
        wardCode: BA_DINH,
        wardName: 'Phường Ba Đình',
        street: '12 Bạch Đằng',
        label: 'Nhà',
      });
      expect(await prisma.address.count({ where: { userId: U1 } })).toBe(1);
    });

    it('makes the first address the default, whatever isDefault says', async () => {
      const first = await add(U1, { isDefault: false });

      expect(first.isDefault).toBe(true);
    });

    it('does not make a later address the default unless asked', async () => {
      const first = await addSlowly(U1);
      const second = await add(U1);

      expect(second.isDefault).toBe(false);
      expect((await defaultsOf(U1)).map((a) => a.id)).toEqual([first.id]);
    });

    it('moves the default to a later address that asks for it, in one step', async () => {
      await addSlowly(U1);
      const second = await add(U1, { isDefault: true });

      expect(second.isDefault).toBe(true);
      expect((await defaultsOf(U1)).map((a) => a.id)).toEqual([second.id]);
    });

    it('tidies the texts and normalises the phone number', async () => {
      const address = await add(U1, {
        recipientName: '  Nguyễn   Văn\tA ',
        phone: '+84 912.345.678',
        label: '   ',
      });

      expect(address).toMatchObject({
        recipientName: 'Nguyễn Văn A',
        phone: '0912345678',
        label: null,
      });
    });
  });

  describe('listing (AC-1)', () => {
    it('lists the default first and then the newest, and only the user’s own', async () => {
      const a = await addSlowly(U1); // default
      const b = await addSlowly(U1);
      const c = await addSlowly(U1);
      await add(U2);

      expect((await list(U1)).map((x) => x.id)).toEqual([a.id, c.id, b.id]);
      expect(await list(U2)).toHaveLength(1);
    });

    it('gives an empty list when there is no address', async () => {
      expect(await list(U1)).toEqual([]);
    });
  });

  // ── AC-3 ───────────────────────────────────────────────────────────────────

  describe('invalid data (AC-3)', () => {
    it.each([
      ['recipientName', { recipientName: '   ' }],
      ['recipientName', { recipientName: 'x'.repeat(101) }],
      ['phone', { phone: '12345' }],
      ['street', { street: '' }],
      ['street', { street: 'y'.repeat(256) }],
      ['label', { label: 'z'.repeat(51) }],
    ])(
      'refuses a wrong %s with ADDR-003 and saves nothing',
      async (field, bad) => {
        const failure = await failureOf(
          add(U1, bad as Partial<AddAddressInput>),
        );

        expect(failure.code).toBe('ADDR-003');
        expect(failure.details.field).toBe(field);
        expect(await prisma.address.count()).toBe(0);
      },
    );

    it('refuses a ward that is not in the catalog with ADDR-003 / WARD_NOT_FOUND', async () => {
      const failure = await failureOf(add(U1, { wardCode: '99999' }));

      expect(failure).toMatchObject({
        code: 'ADDR-003',
        details: { field: 'wardCode', reason: 'WARD_NOT_FOUND' },
      });
      expect(await prisma.address.count()).toBe(0);
    });

    it('treats a ward code that is made of SQL as just a ward that does not exist', async () => {
      const failure = await failureOf(
        add(U1, { wardCode: "00004' OR '1'='1" }),
      );

      expect(failure.details.reason).toBe('WARD_NOT_FOUND');
    });
  });

  // ── AC-4 ───────────────────────────────────────────────────────────────────

  describe('the limit of 10 addresses (AC-4)', () => {
    it('refuses the eleventh with ADDR-002, and accepts one again after a delete', async () => {
      const made: Address[] = [];
      for (let i = 0; i < 10; i++) made.push(await add(U1));

      const failure = await failureOf(add(U1));
      expect(failure.code).toBe('ADDR-002');
      expect(await prisma.address.count({ where: { userId: U1 } })).toBe(10);

      await remove(U1, made[5].id);
      await expect(add(U1)).resolves.toBeDefined();
      expect(await prisma.address.count({ where: { userId: U1 } })).toBe(10);
    });

    it('counts each user separately', async () => {
      for (let i = 0; i < 10; i++) await add(U1);

      await expect(add(U2)).resolves.toBeDefined();
    });
  });

  // ── AC-5 ───────────────────────────────────────────────────────────────────

  describe('changing (AC-5)', () => {
    it('changes only the fields that are sent and keeps the default flag and creation time', async () => {
      const original = await add(U1, { label: 'Nhà' });

      const changed = await update(U1, original.id, { street: '5 Lê Duẩn' });

      expect(changed).toMatchObject({
        street: '5 Lê Duẩn',
        label: 'Nhà',
        recipientName: 'Nguyễn Văn A',
        phone: '0912345678',
        wardCode: BA_DINH,
        isDefault: true,
      });
      expect(changed.createdAt.getTime()).toBe(original.createdAt.getTime());
    });

    it('removes the label with null', async () => {
      const original = await add(U1, { label: 'Nhà' });

      const changed = await update(U1, original.id, { label: null });

      expect(changed.label).toBeNull();
    });

    it('takes the new province and names when the ward changes', async () => {
      const original = await add(U1);

      const changed = await update(U1, original.id, { wardCode: HAI_CHAU });

      expect(changed).toMatchObject({
        provinceCode: '48',
        provinceName: 'Thành phố Đà Nẵng',
        wardCode: HAI_CHAU,
        wardName: 'Phường Hải Châu',
      });
    });

    it('keeps the saved names when the catalog is renamed and only the street is changed', async () => {
      const original = await add(U1);
      await prisma.ward.update({
        where: { code: BA_DINH },
        data: { name: 'Tên Mới' },
      });
      await prisma.province.update({
        where: { code: '01' },
        data: { name: 'Thủ đô' },
      });

      const changed = await update(U1, original.id, { street: '5 Lê Duẩn' });
      const sameWard = await update(U1, original.id, { wardCode: BA_DINH });

      expect(changed.wardName).toBe('Phường Ba Đình');
      expect(changed.provinceName).toBe('Thành phố Hà Nội');
      // sending the ward it already has changes nothing either
      expect(sameWard.wardName).toBe('Phường Ba Đình');
      expect(sameWard.provinceName).toBe('Thành phố Hà Nội');
    });

    it('refuses an update with nothing in it, a wrong value, or an unknown ward, and changes nothing', async () => {
      const original = await add(U1);

      expect(
        (await failureOf(update(U1, original.id, {}))).details.reason,
      ).toBe('NOTHING_TO_UPDATE');
      expect(
        (await failureOf(update(U1, original.id, { phone: '1' }))).details
          .field,
      ).toBe('phone');
      expect(
        (await failureOf(update(U1, original.id, { wardCode: '12345' })))
          .details.reason,
      ).toBe('WARD_NOT_FOUND');

      const stored = await prisma.address.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(stored).toMatchObject({
        phone: '0912345678',
        wardCode: BA_DINH,
        street: '12 Bạch Đằng',
      });
    });
  });

  // ── AC-6, AC-7 ─────────────────────────────────────────────────────────────

  describe('the default (AC-6)', () => {
    it('moves the default to another address, with exactly one default at the end', async () => {
      const first = await addSlowly(U1);
      const second = await add(U1);

      const result = await setDefault(U1, second.id);

      expect(result.isDefault).toBe(true);
      expect((await defaultsOf(U1)).map((a) => a.id)).toEqual([second.id]);
      expect(first.id).not.toBe(second.id);
    });

    it('does nothing, and does not fail, for the address that already is the default', async () => {
      const first = await add(U1);

      const result = await setDefault(U1, first.id);

      expect(result.isDefault).toBe(true);
      expect(await defaultsOf(U1)).toHaveLength(1);
    });
  });

  describe('deleting (AC-7)', () => {
    it('makes the newest remaining address the default when the default is deleted', async () => {
      const a = await addSlowly(U1); // default
      await addSlowly(U1);
      const newest = await addSlowly(U1);

      await remove(U1, a.id);

      expect((await defaultsOf(U1)).map((x) => x.id)).toEqual([newest.id]);
    });

    it('leaves the default alone when another address is deleted', async () => {
      const a = await addSlowly(U1); // default
      const b = await addSlowly(U1);

      await remove(U1, b.id);

      expect((await defaultsOf(U1)).map((x) => x.id)).toEqual([a.id]);
    });

    it('leaves no address and no default after the last one is deleted', async () => {
      const only = await add(U1);

      await remove(U1, only.id);

      expect(await list(U1)).toEqual([]);
      // a new first address becomes the default again
      expect((await add(U1)).isDefault).toBe(true);
    });
  });

  // ── AC-8 ───────────────────────────────────────────────────────────────────

  describe('addresses of other users (AC-8)', () => {
    it('answers ADDR-001, the same as for a missing id, and changes nothing', async () => {
      const mine = await add(U1, { label: 'Nhà' });
      const before = await prisma.address.findUniqueOrThrow({
        where: { id: mine.id },
      });

      const attempts = await Promise.all([
        failureOf(update(U2, mine.id, { street: 'hacked' })),
        failureOf(setDefault(U2, mine.id)),
        failureOf(remove(U2, mine.id)),
        failureOf(setDefault(U2, 'no-such-id')),
        failureOf(remove(U2, 'no-such-id')),
        failureOf(update(U2, 'no-such-id', { street: 'x' })),
      ]);

      for (const attempt of attempts) expect(attempt.code).toBe('ADDR-001');
      expect(
        await prisma.address.findUniqueOrThrow({ where: { id: mine.id } }),
      ).toEqual(before);
      expect(await list(U2)).toEqual([]);
    });
  });

  // ── AC-9 ───────────────────────────────────────────────────────────────────

  describe('requests at the same time (AC-9)', () => {
    it('keeps exactly one default when many addresses are made the default at once', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push((await addSlowly(U1)).id);

      const results = await Promise.all(
        [...ids, ...ids, ...ids].map((id) => settle(setDefault(U1, id))),
      );

      expect(results.every((r) => r.ok)).toBe(true);
      expect(await defaultsOf(U1)).toHaveLength(1);
    });

    it('lets exactly one of five simultaneous adds in when there are already nine', async () => {
      for (let i = 0; i < 9; i++) await add(U1);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => settle(add(U1))),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const refused = results.filter((r) => !r.ok);
      expect(refused).toHaveLength(4);
      for (const r of refused)
        expect((r as { code: string }).code).toBe('ADDR-002');
      expect(await prisma.address.count({ where: { userId: U1 } })).toBe(10);
      expect(await defaultsOf(U1)).toHaveLength(1);
    });

    it('keeps one default and at most 10 addresses when the default is deleted while others are added', async () => {
      const first = await addSlowly(U1); // default
      for (let i = 0; i < 7; i++) await addSlowly(U1);

      const results = await Promise.all([
        settle(remove(U1, first.id)),
        ...Array.from({ length: 6 }, () => settle(add(U1))),
      ]);

      const unexpected = results.filter(
        (r) => !r.ok && (r as { code: string }).code !== 'ADDR-002',
      );
      expect(unexpected).toEqual([]);
      const total = await prisma.address.count({ where: { userId: U1 } });
      expect(total).toBeLessThanOrEqual(10);
      expect(await defaultsOf(U1)).toHaveLength(1);
    });

    it('keeps one default when several first-time adds of a new default race each other', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => settle(add(U1, { isDefault: true }))),
      );

      expect(results.every((r) => r.ok)).toBe(true);
      expect(await defaultsOf(U1)).toHaveLength(1);
      expect(await prisma.address.count({ where: { userId: U1 } })).toBe(6);
    });

    describe('only requests of the same user wait for each other', () => {
      /** Holds the lock of a user for a while, the way a slow address change would */
      const holdLock = (userId: string, ms: number) => {
        const state = { released: false };
        const done = prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
          await sleep(ms);
          state.released = true;
        });
        return { state, done };
      };

      it('lets another user go on, and makes the same user wait', async () => {
        const holder = holdLock(U1, 700);
        await sleep(150); // the lock is taken

        const other = add(U2).then(() => holder.state.released);
        const same = add(U1).then(() => holder.state.released);

        expect(await other).toBe(false); // U2 finished while U1's lock was still held
        expect(await same).toBe(true); // U1 had to wait until it was released
        await holder.done;
      });

      it('does not hold back something that only points at the user, such as a new login', async () => {
        const holder = holdLock(U1, 700);
        await sleep(150);

        await prisma.userCredential.create({
          data: {
            id: 'ad_cred_1',
            userId: U1,
            provider: 'EMAIL',
            identifier: 'ad_user_1@example.com',
          },
        });

        expect(holder.state.released).toBe(false);
        await holder.done;
      });
    });
  });

  // ── AC-10, AC-11 ───────────────────────────────────────────────────────────

  describe('what the database refuses itself (AC-10, AC-11)', () => {
    const row = (id: string, userId: string, overrides = {}) => ({
      id,
      userId,
      recipientName: 'A',
      phone: '0912345678',
      provinceCode: '01',
      provinceName: 'Thành phố Hà Nội',
      wardCode: BA_DINH,
      wardName: 'Phường Ba Đình',
      street: 'x',
      ...overrides,
    });

    it('refuses a second default of the same user, but not defaults of two users or many non-defaults', async () => {
      await prisma.address.create({
        data: row('ad_a1', U1, { isDefault: true }),
      });

      await expect(
        prisma.address.create({ data: row('ad_a2', U1, { isDefault: true }) }),
      ).rejects.toThrow();
      await expect(
        prisma.address.create({ data: row('ad_a3', U2, { isDefault: true }) }),
      ).resolves.toBeDefined();
      await expect(
        prisma.address.createMany({
          data: [row('ad_a4', U1), row('ad_a5', U1), row('ad_a6', U1)],
        }),
      ).resolves.toBeDefined();
    });

    it('refuses empty texts, and a ward or province that is not in the catalog', async () => {
      await expect(
        prisma.address.create({ data: row('ad_b1', U1, { street: '  ' }) }),
      ).rejects.toThrow();
      await expect(
        prisma.address.create({
          data: row('ad_b2', U1, { recipientName: '' }),
        }),
      ).rejects.toThrow();
      await expect(
        prisma.address.create({
          data: row('ad_b3', U1, { wardCode: '99999' }),
        }),
      ).rejects.toThrow();
      await expect(
        prisma.address.create({
          data: row('ad_b4', U1, { provinceCode: '99' }),
        }),
      ).rejects.toThrow();
    });

    it('deletes the addresses of a user together with the user', async () => {
      await add(U1);
      await add(U1);
      await add(U2);

      await prisma.user.delete({ where: { id: U1 } });

      expect(await prisma.address.count({ where: { userId: U1 } })).toBe(0);
      expect(await prisma.address.count({ where: { userId: U2 } })).toBe(1);
    });

    it('refuses to delete a ward or province that an address still uses', async () => {
      await add(U1);

      await expect(
        prisma.ward.delete({ where: { code: BA_DINH } }),
      ).rejects.toThrow();
      await expect(
        prisma.province.delete({ where: { code: '01' } }),
      ).rejects.toThrow();
    });
  });

  // ── AC-12 ──────────────────────────────────────────────────────────────────

  describe('the snapshot for an order (AC-12)', () => {
    const snapshotOf = (userId: string, addressId: string) =>
      queries.execute<GetAddressQuery, AddressSnapshot>(
        new GetAddressQuery(userId, addressId),
      );

    it('gives the eight content fields and nothing else, and is not changed by later edits', async () => {
      const address = await add(U1, { label: 'Nhà' });

      const snapshot = await snapshotOf(U1, address.id);
      await update(U1, address.id, { street: 'somewhere else' });
      await remove(U1, address.id);

      expect(Object.keys(snapshot).sort()).toEqual([
        'label',
        'phone',
        'provinceCode',
        'provinceName',
        'recipientName',
        'street',
        'wardCode',
        'wardName',
      ]);
      expect(snapshot).toEqual({
        recipientName: 'Nguyễn Văn A',
        phone: '0912345678',
        provinceCode: '01',
        provinceName: 'Thành phố Hà Nội',
        wardCode: BA_DINH,
        wardName: 'Phường Ba Đình',
        street: '12 Bạch Đằng',
        label: 'Nhà',
      });
    });

    it('answers ADDR-001 for another user’s address and for one that does not exist', async () => {
      const address = await add(U1);

      expect((await failureOf(snapshotOf(U2, address.id))).code).toBe(
        'ADDR-001',
      );
      expect((await failureOf(snapshotOf(U1, 'nope'))).code).toBe('ADDR-001');
    });
  });

  // ── AC-13 ──────────────────────────────────────────────────────────────────

  describe('personal data stays out of logs and errors (AC-13)', () => {
    it('never writes the phone number or the street to a log, and puts neither in an error', async () => {
      const PHONE = '0987123456';
      const STREET = 'Số 77 Ngõ Bí Mật';
      const written: string[] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (level) =>
          vi
            .spyOn(Logger.prototype, level)
            .mockImplementation((...args: unknown[]) => {
              written.push(JSON.stringify(args));
            }),
      );
      const consoleSpies = (
        ['log', 'warn', 'error', 'info', 'debug'] as const
      ).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          written.push(JSON.stringify(args));
        }),
      );
      try {
        const good = await add(U1, { phone: PHONE, street: STREET });
        const failures = [
          await failureOf(
            add(U1, { phone: PHONE, street: STREET, wardCode: '99999' }),
          ),
          await failureOf(add(U1, { phone: '1', street: STREET })),
          await failureOf(update(U2, good.id, { street: STREET })),
        ];
        await update(U1, good.id, { phone: PHONE, street: STREET });
        await remove(U1, good.id);

        for (const failure of failures) {
          expect(JSON.stringify(failure)).not.toContain(STREET);
          expect(JSON.stringify(failure)).not.toContain(PHONE);
        }
      } finally {
        for (const spy of [...spies, ...consoleSpies]) spy.mockRestore();
      }

      const everything = written.join('\n');
      expect(everything).not.toContain(PHONE);
      expect(everything).not.toContain(STREET);
    });
  });
});
