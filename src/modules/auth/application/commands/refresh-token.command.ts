import { ICommand } from '@nestjs/cqrs';

export class RefreshTokenCommand implements ICommand {
  constructor(
    public readonly refreshToken: string,
    /** IP of this request; recorded as the session's most recent IP. */
    public readonly ipAddress: string,
  ) {}
}
