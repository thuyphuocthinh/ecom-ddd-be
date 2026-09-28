import { ICommand } from '@nestjs/cqrs';

export class MoveCategoryCommand implements ICommand {
  constructor(
    public readonly id: string,
    public readonly newParentId: string | null,
  ) {}
}
