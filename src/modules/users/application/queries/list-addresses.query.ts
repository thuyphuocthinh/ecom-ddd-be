import { IQuery } from '@nestjs/cqrs';

export class ListAddressesQuery implements IQuery {
  constructor(public readonly userId: string) {}
}
