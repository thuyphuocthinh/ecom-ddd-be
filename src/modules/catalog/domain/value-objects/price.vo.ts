import { ValueObject, CatalogErrorCodes } from '@/core/index.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';
import type { Prisma } from '@prisma/client';

export interface PriceProps {
  amount: number;
}

export class Price extends ValueObject<PriceProps> {
  private constructor(props: PriceProps) {
    super(props);
  }

  static create(amount: number): Price {
    if (amount < 0) {
      throw new CatalogDomainException(CatalogErrorCodes.NEGATIVE_PRICE);
    }
    return new Price({ amount });
  }

  // Prisma stores price as a Decimal; this is the single place that
  // conversion happens so precision handling stays in one spot.
  static fromDecimal(decimal: Prisma.Decimal | number): Price {
    return Price.create(Number(decimal));
  }

  get amount(): number {
    return this.props.amount;
  }
}
