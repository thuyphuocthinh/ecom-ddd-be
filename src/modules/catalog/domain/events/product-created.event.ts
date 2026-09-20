import { DomainEvent } from '@/core/index.js';

export class ProductCreatedEvent extends DomainEvent {
  constructor(
    public readonly aggregateId: string,
    public readonly productName: string,
    public readonly skusCount: number,
  ) {
    super(aggregateId);
  }
}
