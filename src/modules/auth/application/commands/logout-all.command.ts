import { ICommand } from '@nestjs/cqrs';

export class LogoutAllCommand implements ICommand {
  constructor(public readonly userId: string) {}
}
