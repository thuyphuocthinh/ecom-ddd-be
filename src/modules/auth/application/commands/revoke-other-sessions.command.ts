import { ICommand } from '@nestjs/cqrs';

/** Ends every session of the user except the one making the request. */
export class RevokeOtherSessionsCommand implements ICommand {
  constructor(
    public readonly userId: string,
    public readonly currentSessionId: string,
  ) {}
}
