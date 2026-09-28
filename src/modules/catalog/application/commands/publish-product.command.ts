import { ICommand } from '@nestjs/cqrs';

export class PublishProductCommand implements ICommand {
  constructor(public readonly id: string) {}
}
