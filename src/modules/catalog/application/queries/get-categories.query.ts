import { IQuery } from '@nestjs/cqrs';

export class GetCategoriesQuery implements IQuery {
  constructor(public readonly parentId?: string) {}
}
