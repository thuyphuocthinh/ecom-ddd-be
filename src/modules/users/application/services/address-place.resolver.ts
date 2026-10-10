import { Injectable } from '@nestjs/common';
import {
  AddressErrorCodes,
  DomainException,
  LocationErrorCodes,
} from '@/core/index.js';
import { LocationsService } from '../../../locations/locations.service.js';
import { AddressDomainException } from '../../domain/index.js';
import type { AddressPlace } from '../../domain/index.js';

/**
 * Turns the ward code the user picked into the place of an address: the ward and the province it
 * belongs to, with their full names, taken from the administrative units. The province is never
 * taken from the request, so a ward and a province that do not match cannot be saved.
 */
@Injectable()
export class AddressPlaceResolver {
  constructor(private readonly locations: LocationsService) {}

  async resolve(wardCode: unknown): Promise<AddressPlace> {
    if (typeof wardCode !== 'string') throw this.wardNotFound('REQUIRED');
    try {
      const ward = await this.locations.getWard(wardCode);
      return {
        provinceCode: ward.province.code,
        provinceName: ward.province.fullName,
        wardCode: ward.code,
        wardName: ward.fullName,
      };
    } catch (error) {
      if (
        error instanceof DomainException &&
        error.code === LocationErrorCodes.WARD_NOT_FOUND.code
      ) {
        throw this.wardNotFound('WARD_NOT_FOUND');
      }
      throw error;
    }
  }

  private wardNotFound(reason: string) {
    return new AddressDomainException(AddressErrorCodes.INVALID_ADDRESS, {
      field: 'wardCode',
      reason,
    });
  }
}
