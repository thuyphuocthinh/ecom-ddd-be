import { ICommand } from '@nestjs/cqrs';

export class ChangePasswordCommand implements ICommand {
  constructor(
    public readonly userId: string,
    /** The session the change is made from; it stays open. */
    public readonly sessionId: string,
    public readonly currentPassword: string,
    public readonly newPassword: string,
  ) {}
}
