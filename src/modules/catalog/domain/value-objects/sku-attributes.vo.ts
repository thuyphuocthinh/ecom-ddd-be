import { ValueObject, CatalogErrorCodes } from '@/core/index.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';

export class SkuAttributes extends ValueObject<Record<string, string>> {
  private constructor(props: Record<string, string>) {
    super(props);
  }

  static create(attributes: Record<string, string>): SkuAttributes {
    const entries = Object.entries(attributes ?? {});

    for (const [key, value] of entries) {
      if (!key.trim() || typeof value !== 'string' || !value.trim()) {
        throw new CatalogDomainException(
          CatalogErrorCodes.INVALID_SKU_ATTRIBUTES,
          'SKU attribute keys and values must be non-empty strings',
        );
      }
    }

    // Sorted by key so two structurally-equal attribute sets always compare
    // equal via the base ValueObject's JSON.stringify-based equals(),
    // regardless of the original key order.
    const sorted = Object.fromEntries(
      entries.sort(([a], [b]) => a.localeCompare(b)),
    );
    return new SkuAttributes(sorted);
  }

  toPlainObject(): Record<string, string> {
    return { ...this.props };
  }
}
