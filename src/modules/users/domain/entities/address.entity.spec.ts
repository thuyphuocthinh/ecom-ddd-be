import { Address } from './address.entity.js';
import type { AddressPlace } from './address.entity.js';

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

const make = (overrides: Record<string, unknown> = {}) =>
  Address.create({
    id: 'a1',
    userId: 'u1',
    recipientName: 'Nguyễn Văn A',
    phone: '0912345678',
    street: '12 Bạch Đằng',
    place: HA_NOI,
    ...overrides,
  });

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error: any) {
    return { code: error.code, details: error.details };
  }
  throw new Error('should have failed');
};

describe('Address', () => {
  describe('create', () => {
    it('keeps good values and takes the place as given', () => {
      const address = make({ label: 'Nhà' });

      expect(address).toMatchObject({
        id: 'a1',
        userId: 'u1',
        recipientName: 'Nguyễn Văn A',
        phone: '0912345678',
        street: '12 Bạch Đằng',
        label: 'Nhà',
        isDefault: false,
        ...HA_NOI,
      });
    });

    it('tidies the texts and normalises the phone number', () => {
      const address = make({
        recipientName: '   Nguyễn \t Văn\n A  ',
        phone: '+84 912.345.678',
        street: '  12   Bạch Đằng​ ',
        label: '  Công   ty ',
      });

      expect(address.recipientName).toBe('Nguyễn Văn A');
      expect(address.phone).toBe('0912345678');
      expect(address.street).toBe('12 Bạch Đằng');
      expect(address.label).toBe('Công ty');
    });

    it('has no label when it is missing, null, or only spaces', () => {
      expect(make().label).toBeNull();
      expect(make({ label: null }).label).toBeNull();
      expect(make({ label: '   ' }).label).toBeNull();
    });

    it.each([
      ['recipientName', ''],
      ['recipientName', '   \n  '],
      ['recipientName', '​​'],
      ['recipientName', undefined],
      ['recipientName', 42],
      ['recipientName', 'x'.repeat(101)],
      ['street', ''],
      ['street', '   '],
      ['street', undefined],
      ['street', 'x'.repeat(256)],
      ['label', 'x'.repeat(51)],
      ['label', 42],
      ['phone', ''],
      ['phone', 'abc'],
      ['phone', '091234567'],
      ['phone', undefined],
    ])('refuses %s = %j with ADDR-003 naming the field', (field, value) => {
      const result = failure(() => make({ [field]: value }));

      expect(result.code).toBe('ADDR-003');
      expect(result.details.field).toBe(field);
    });

    it('accepts texts exactly at the limit', () => {
      expect(() =>
        make({
          recipientName: 'x'.repeat(100),
          street: 'y'.repeat(255),
          label: 'z'.repeat(50),
        }),
      ).not.toThrow();
    });

    it('counts characters the way the database column does, so a long text of emoji is refused', () => {
      // 60 family emoji look like 60 characters but are far more than 100 code points
      const result = failure(() => make({ recipientName: '👨‍👩‍👧'.repeat(60) }));

      expect(result.details).toMatchObject({
        field: 'recipientName',
        reason: 'TOO_LONG',
      });
    });
  });

  describe('withChanges', () => {
    it('changes only the given fields and leaves the rest, the default flag and the creation time', () => {
      const original = make({ label: 'Nhà', isDefault: true });

      const changed = original.withChanges({ street: '5 Lê Duẩn' });

      expect(changed.street).toBe('5 Lê Duẩn');
      expect(changed).toMatchObject({
        id: 'a1',
        recipientName: 'Nguyễn Văn A',
        phone: '0912345678',
        label: 'Nhà',
        isDefault: true,
        ...HA_NOI,
      });
      expect(changed.createdAt).toBe(original.createdAt);
    });

    it('takes a new place as a whole (ward and province together)', () => {
      const changed = make().withChanges({ place: DA_NANG });

      expect(changed).toMatchObject(DA_NANG);
    });

    it('removes the label with null, keeps it when not mentioned', () => {
      const original = make({ label: 'Nhà' });

      expect(original.withChanges({ label: null }).label).toBeNull();
      expect(original.withChanges({ street: 'x' }).label).toBe('Nhà');
    });

    it('checks the changed fields again', () => {
      expect(
        failure(() => make().withChanges({ phone: '123' })).details,
      ).toMatchObject({
        field: 'phone',
      });
      expect(
        failure(() => make().withChanges({ street: '  ' })).details,
      ).toMatchObject({
        field: 'street',
      });
    });
  });

  it('gives a snapshot of only the content: eight fields, no ids, flag or times', () => {
    const snapshot = make({ label: 'Nhà', isDefault: true }).toSnapshot();

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
      wardCode: '00004',
      wardName: 'Phường Ba Đình',
      street: '12 Bạch Đằng',
      label: 'Nhà',
    });
  });
});
