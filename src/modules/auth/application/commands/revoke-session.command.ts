import { ICommand } from '@nestjs/cqrs';

/** Ends one of the user's own sessions (another device). */
export class RevokeSessionCommand implements ICommand {
  constructor(
    public readonly userId: string,
    public readonly sessionId: string,
  ) {}
}
