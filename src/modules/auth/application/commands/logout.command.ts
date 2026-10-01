import { ICommand } from '@nestjs/cqrs';

/** Ends the session the request's access token belongs to. */
export class LogoutCommand implements ICommand {
  constructor(
    public readonly sessionId: string,
    public readonly userId: string,
  ) {}
}
