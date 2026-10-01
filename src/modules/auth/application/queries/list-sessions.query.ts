import { IQuery } from '@nestjs/cqrs';

export class ListSessionsQuery implements IQuery {
  constructor(public readonly userId: string) {}
}
