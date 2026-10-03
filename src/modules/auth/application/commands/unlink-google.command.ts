import { ICommand } from '@nestjs/cqrs';

export class UnlinkGoogleCommand implements ICommand {
  constructor(public readonly userId: string) {}
}
