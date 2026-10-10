import { Address } from '../../domain/index.js';
import { AddressResponseDto } from '../dtos/address-response.dto.js';

export class AddressResponseMapper {
  static toResponseDto(address: Address): AddressResponseDto {
    return {
      id: address.id,
      recipientName: address.recipientName,
      phone: address.phone,
      provinceCode: address.provinceCode,
      provinceName: address.provinceName,
      wardCode: address.wardCode,
      wardName: address.wardName,
      street: address.street,
      label: address.label,
      isDefault: address.isDefault,
      createdAt: address.createdAt,
      updatedAt: address.updatedAt,
    };
  }
}
