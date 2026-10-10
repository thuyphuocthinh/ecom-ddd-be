import { AddressErrorCodes } from '@/core/index.js';
import { AddressDomainException } from '../exceptions/address.exception.js';
import { cleanText, hasVisibleCharacter } from '../services/clean-text.js';
import { normalizePhone } from '../services/phone.js';

/** How many addresses one user may keep. */
export const ADDRESS_MAX_PER_USER = 10;

// Longest text of each field, in characters (the same as the size of the database column)
const RECIPIENT_NAME_MAX = 100;
const STREET_MAX = 255;
const LABEL_MAX = 50;

/**
 * Where an address is: the ward the user picked and the province it belongs to. The names are
 * the full names at the time of saving ("Thành phố Hà Nội", "Phường Ba Đình"), copied from the
 * administrative units so the address still reads the same if they are renamed later.
 */
export interface AddressPlace {
  provinceCode: string;
  provinceName: string;
  wardCode: string;
  wardName: string;
}

/**
 * The content of an address as another module (the order) copies it: no ids, no default flag,
 * no times, so later changes to the address book do not reach an order that was already placed.
 */
export interface AddressSnapshot extends AddressPlace {
  recipientName: string;
  phone: string;
  street: string;
  label: string | null;
}

export interface AddressChanges {
  recipientName?: string;
  phone?: string;
  street?: string;
  /** null (or only spaces) removes the label */
  label?: string | null;
  place?: AddressPlace;
}

const invalid = (field: string, reason: string) =>
  new AddressDomainException(AddressErrorCodes.INVALID_ADDRESS, {
    field,
    reason,
  });

/** Cleaned text that must be there and fit in `max` characters; throws ADDR-003 otherwise. */
function requiredText(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string') throw invalid(field, 'REQUIRED');
  const text = cleanText(raw);
  if (!hasVisibleCharacter(text)) throw invalid(field, 'REQUIRED');
  // Counted in code points, the way the database column counts, so it always fits
  if ([...text].length > max) throw invalid(field, 'TOO_LONG');
  return text;
}

function optionalText(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw invalid(field, 'INVALID');
  const text = cleanText(raw);
  if (text === '') return null;
  if (!hasVisibleCharacter(text)) return null;
  if ([...text].length > max) throw invalid(field, 'TOO_LONG');
  return text;
}

function requiredPhone(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('phone', 'REQUIRED');
  const phone = normalizePhone(raw);
  if (phone === null) throw invalid('phone', 'INVALID_PHONE');
  return phone;
}

export class Address {
  private constructor(
    public readonly id: string,
    public readonly userId: string,
    public readonly recipientName: string,
    public readonly phone: string,
    public readonly provinceCode: string,
    public readonly provinceName: string,
    public readonly wardCode: string,
    public readonly wardName: string,
    public readonly street: string,
    public readonly label: string | null,
    public readonly isDefault: boolean,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  /** A new address from what a person typed. Throws ADDR-003 naming the field that is wrong. */
  static create(params: {
    id: string;
    userId: string;
    recipientName: unknown;
    phone: unknown;
    street: unknown;
    label?: unknown;
    place: AddressPlace;
    isDefault?: boolean;
  }): Address {
    const now = new Date();
    return new Address(
      params.id,
      params.userId,
      requiredText(params.recipientName, 'recipientName', RECIPIENT_NAME_MAX),
      requiredPhone(params.phone),
      params.place.provinceCode,
      params.place.provinceName,
      params.place.wardCode,
      params.place.wardName,
      requiredText(params.street, 'street', STREET_MAX),
      optionalText(params.label, 'label', LABEL_MAX),
      params.isDefault ?? false,
      now,
      now,
    );
  }

  /** Rebuilds an address read from the database (nothing is checked again). */
  static restore(data: {
    id: string;
    userId: string;
    recipientName: string;
    phone: string;
    provinceCode: string;
    provinceName: string;
    wardCode: string;
    wardName: string;
    street: string;
    label: string | null;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): Address {
    return new Address(
      data.id,
      data.userId,
      data.recipientName,
      data.phone,
      data.provinceCode,
      data.provinceName,
      data.wardCode,
      data.wardName,
      data.street,
      data.label,
      data.isDefault,
      data.createdAt,
      data.updatedAt,
    );
  }

  /**
   * A copy with only the given fields changed (and checked again); the others, the default flag
   * and the creation time stay as they are.
   */
  withChanges(changes: AddressChanges): Address {
    const place = changes.place ?? this;
    return new Address(
      this.id,
      this.userId,
      changes.recipientName === undefined
        ? this.recipientName
        : requiredText(
            changes.recipientName,
            'recipientName',
            RECIPIENT_NAME_MAX,
          ),
      changes.phone === undefined ? this.phone : requiredPhone(changes.phone),
      place.provinceCode,
      place.provinceName,
      place.wardCode,
      place.wardName,
      changes.street === undefined
        ? this.street
        : requiredText(changes.street, 'street', STREET_MAX),
      changes.label === undefined
        ? this.label
        : optionalText(changes.label, 'label', LABEL_MAX),
      this.isDefault,
      this.createdAt,
      new Date(),
    );
  }

  toSnapshot(): AddressSnapshot {
    return {
      recipientName: this.recipientName,
      phone: this.phone,
      provinceCode: this.provinceCode,
      provinceName: this.provinceName,
      wardCode: this.wardCode,
      wardName: this.wardName,
      street: this.street,
      label: this.label,
    };
  }
}
