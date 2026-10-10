import { vi } from 'vitest';
import { DomainException, LocationErrorCodes } from '@/core/index.js';
import { AddAddressHandler } from './add-address.handler.js';
import { UpdateAddressHandler } from './update-address.handler.js';
import { RemoveAddressHandler } from './remove-address.handler.js';
import { SetDefaultAddressHandler } from './set-default-address.handler.js';
import { GetAddressHandler } from '../queries/get-address.handler.js';
import { AddressPlaceResolver } from '../services/address-place.resolver.js';
import { Address } from '../../domain/index.js';
import type { AddressPlace, IAddressRepository } from '../../domain/index.js';
import type { LocationsService } from '../../../locations/locations.service.js';

const HA_NOI: AddressPlace = {
  provinceCode: '01',
  provinceName: 'Thành phố Hà Nội',
  wardCode: '00004',
  wardName: 'Phường Ba Đình',
};
const DA_NANG: AddressPlace = {
  provinceCode: '48',
  provinceName: 'Thành phố Đà Nẵng',
  wardCode: '20000',
  wardName: 'Phường Hải Châu',
};

const saved = (place = HA_NOI) =>
  Address.create({
    id: 'a1',
    userId: 'u1',
    recipientName: 'Nguyễn Văn A',
    phone: '0912345678',
    street: '12 Bạch Đằng',
    place,
  });

const fakeRepo = () => {
  const repo = {
    list: vi.fn(),
    findOwned: vi.fn(),
    add: vi.fn(
      async (_user: string, address: Address, _makeDefault: boolean) => address,
    ),
    update: vi.fn(
      async (_user: string, address: Address): Promise<Address | null> =>
        address,
    ),
    setDefault: vi.fn(),
    remove: vi.fn(),
  };
  return repo as typeof repo & IAddressRepository;
};

const fakePlaces = (place: AddressPlace = HA_NOI) =>
  ({ resolve: vi.fn(async () => place) }) as unknown as AddressPlaceResolver & {
    resolve: ReturnType<typeof vi.fn>;
  };

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error: any) {
    return { code: error.code, details: error.details };
  }
  throw new Error('should have failed');
};

describe('AddAddressHandler', () => {
  const input = {
    recipientName: 'Nguyễn Văn A',
    phone: '0912345678',
    wardCode: '00004',
    street: '12 Bạch Đằng',
  };

  it('looks the ward up, builds the address from it and lets the repository save it', async () => {
    const repo = fakeRepo();
    const places = fakePlaces();
    const handler = new AddAddressHandler(repo, places);

    const result = await handler.execute({
      userId: 'u1',
      input: { ...input, label: 'Nhà' },
    });

    expect(places.resolve).toHaveBeenCalledWith('00004');
    expect(repo.add).toHaveBeenCalledTimes(1);
    const [userId, address, makeDefault] = repo.add.mock.calls[0];
    expect(userId).toBe('u1');
    expect(address).toMatchObject({ ...HA_NOI, label: 'Nhà', userId: 'u1' });
    expect(address.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(makeDefault).toBe(false);
    expect(result).toBe(address);
  });

  it('asks for the default only when isDefault is exactly true', async () => {
    const repo = fakeRepo();
    const handler = new AddAddressHandler(repo, fakePlaces());

    await handler.execute({
      userId: 'u1',
      input: { ...input, isDefault: true },
    });
    await handler.execute({
      userId: 'u1',
      input: { ...input, isDefault: false },
    });
    await handler.execute({ userId: 'u1', input });

    expect(repo.add.mock.calls.map((call) => call[2])).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('saves nothing when a field is wrong (ADDR-003 naming the field)', async () => {
    const repo = fakeRepo();
    const handler = new AddAddressHandler(repo, fakePlaces());

    const failure = await codeOf(
      handler.execute({ userId: 'u1', input: { ...input, phone: '123' } }),
    );

    expect(failure.code).toBe('ADDR-003');
    expect(failure.details.field).toBe('phone');
    expect(repo.add).not.toHaveBeenCalled();
  });

  it('saves nothing when the ward is not found', async () => {
    const repo = fakeRepo();
    const places = fakePlaces();
    places.resolve.mockRejectedValue(
      Object.assign(new Error(), { code: 'ADDR-003' }),
    );
    const handler = new AddAddressHandler(repo, places);

    await expect(
      handler.execute({ userId: 'u1', input }),
    ).rejects.toMatchObject({ code: 'ADDR-003' });
    expect(repo.add).not.toHaveBeenCalled();
  });
});

describe('UpdateAddressHandler', () => {
  it('changes only what is sent and does not look the ward up when it is not mentioned', async () => {
    const repo = fakeRepo();
    repo.findOwned.mockResolvedValue(saved());
    const places = fakePlaces();
    const handler = new UpdateAddressHandler(repo, places);

    const result = await handler.execute({
      userId: 'u1',
      addressId: 'a1',
      changes: { street: '5 Lê Duẩn' },
    });

    expect(places.resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ street: '5 Lê Duẩn', ...HA_NOI });
    expect(repo.update).toHaveBeenCalledWith('u1', result);
  });

  it('keeps the saved names when the same ward code is sent again', async () => {
    const repo = fakeRepo();
    repo.findOwned.mockResolvedValue(saved());
    const places = fakePlaces(DA_NANG);
    const handler = new UpdateAddressHandler(repo, places);

    const result = await handler.execute({
      userId: 'u1',
      addressId: 'a1',
      changes: { wardCode: '00004', phone: '0987654321' },
    });

    expect(places.resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ...HA_NOI, phone: '0987654321' });
  });

  it('takes the new province and names when the ward changes', async () => {
    const repo = fakeRepo();
    repo.findOwned.mockResolvedValue(saved());
    const places = fakePlaces(DA_NANG);
    const handler = new UpdateAddressHandler(repo, places);

    const result = await handler.execute({
      userId: 'u1',
      addressId: 'a1',
      changes: { wardCode: '20000' },
    });

    expect(places.resolve).toHaveBeenCalledWith('20000');
    expect(result).toMatchObject(DA_NANG);
  });

  it('refuses an update that changes nothing (ADDR-003)', async () => {
    const repo = fakeRepo();
    const handler = new UpdateAddressHandler(repo, fakePlaces());

    const failure = await codeOf(
      handler.execute({ userId: 'u1', addressId: 'a1', changes: {} }),
    );

    expect(failure).toMatchObject({
      code: 'ADDR-003',
      details: { reason: 'NOTHING_TO_UPDATE' },
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('answers ADDR-001 for an address that is not the user’s, without looking anything up', async () => {
    const repo = fakeRepo();
    repo.findOwned.mockResolvedValue(null);
    const places = fakePlaces();
    const handler = new UpdateAddressHandler(repo, places);

    const failure = await codeOf(
      handler.execute({
        userId: 'u1',
        addressId: 'someone-elses',
        changes: { wardCode: '20000' },
      }),
    );

    expect(failure.code).toBe('ADDR-001');
    expect(places.resolve).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('answers ADDR-001 when the address was deleted while the update was running', async () => {
    const repo = fakeRepo();
    repo.findOwned.mockResolvedValue(saved());
    repo.update.mockResolvedValue(null);
    const handler = new UpdateAddressHandler(repo, fakePlaces());

    const failure = await codeOf(
      handler.execute({
        userId: 'u1',
        addressId: 'a1',
        changes: { street: 'x' },
      }),
    );

    expect(failure.code).toBe('ADDR-001');
  });
});

describe('RemoveAddressHandler and SetDefaultAddressHandler', () => {
  it('answer ADDR-001 when the repository says the address is not the user’s', async () => {
    const repo = fakeRepo();
    repo.remove.mockResolvedValue(false);
    repo.setDefault.mockResolvedValue(null);

    expect(
      (
        await codeOf(
          new RemoveAddressHandler(repo).execute({
            userId: 'u1',
            addressId: 'x',
          }),
        )
      ).code,
    ).toBe('ADDR-001');
    expect(
      (
        await codeOf(
          new SetDefaultAddressHandler(repo).execute({
            userId: 'u1',
            addressId: 'x',
          }),
        )
      ).code,
    ).toBe('ADDR-001');
  });

  it('pass the answer on when it worked', async () => {
    const repo = fakeRepo();
    repo.remove.mockResolvedValue(true);
    repo.setDefault.mockResolvedValue(saved());

    await expect(
      new RemoveAddressHandler(repo).execute({ userId: 'u1', addressId: 'a1' }),
    ).resolves.toBeUndefined();
    await expect(
      new SetDefaultAddressHandler(repo).execute({
        userId: 'u1',
        addressId: 'a1',
      }),
    ).resolves.toMatchObject({ id: 'a1' });
  });
});

describe('GetAddressHandler', () => {
  it('gives the snapshot of the address', async () => {
    const repo = fakeRepo();
    repo.findOwned.mockResolvedValue(saved());

    const snapshot = await new GetAddressHandler(repo).execute({
      userId: 'u1',
      addressId: 'a1',
    });

    expect(Object.keys(snapshot)).toHaveLength(8);
    expect(snapshot).not.toHaveProperty('id');
    expect(snapshot).not.toHaveProperty('isDefault');
  });

  it('answers ADDR-001 for another user’s address and for one that does not exist', async () => {
    const repo = fakeRepo();
    repo.findOwned.mockResolvedValue(null);

    const failure = await codeOf(
      new GetAddressHandler(repo).execute({ userId: 'u1', addressId: 'x' }),
    );

    expect(failure.code).toBe('ADDR-001');
  });
});

describe('AddressPlaceResolver', () => {
  const locations = (getWard: () => Promise<unknown>) =>
    ({ getWard }) as unknown as LocationsService;

  it('gives the ward and its province with their full names', async () => {
    const resolver = new AddressPlaceResolver(
      locations(async () => ({
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
      })),
    );

    expect(await resolver.resolve('00004')).toEqual(HA_NOI);
  });

  it('turns LOC-002 into ADDR-003 with the reason WARD_NOT_FOUND', async () => {
    const resolver = new AddressPlaceResolver(
      locations(async () => {
        throw new DomainException(LocationErrorCodes.WARD_NOT_FOUND);
      }),
    );

    expect(await codeOf(resolver.resolve('99999'))).toEqual({
      code: 'ADDR-003',
      details: { field: 'wardCode', reason: 'WARD_NOT_FOUND' },
    });
  });

  it('refuses a ward code that is not text without asking the catalog', async () => {
    const getWard = vi.fn();
    const resolver = new AddressPlaceResolver(locations(getWard));

    expect((await codeOf(resolver.resolve(undefined))).code).toBe('ADDR-003');
    expect((await codeOf(resolver.resolve(null))).code).toBe('ADDR-003');
    expect(getWard).not.toHaveBeenCalled();
  });

  it('lets any other failure through unchanged', async () => {
    const boom = new Error('database down');
    const resolver = new AddressPlaceResolver(
      locations(async () => {
        throw boom;
      }),
    );

    await expect(resolver.resolve('00004')).rejects.toBe(boom);
  });
});
