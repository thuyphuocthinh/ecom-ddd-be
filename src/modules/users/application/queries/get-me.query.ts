import { IQuery } from '@nestjs/cqrs';

export class GetMeQuery implements IQuery {
  constructor(public readonly userId: string) {}
}
