import { ICommand } from '@nestjs/cqrs';

export class UnpublishProductCommand implements ICommand {
  constructor(public readonly id: string) {}
}
