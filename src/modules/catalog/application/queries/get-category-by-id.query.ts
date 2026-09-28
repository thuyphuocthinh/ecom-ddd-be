import { IQuery } from '@nestjs/cqrs';

export class GetCategoryByIdQuery implements IQuery {
  constructor(public readonly id: string) {}
}
