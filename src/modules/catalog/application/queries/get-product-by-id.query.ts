import { IQuery } from '@nestjs/cqrs';

export class GetProductByIdQuery implements IQuery {
  constructor(public readonly id: string) {}
}
