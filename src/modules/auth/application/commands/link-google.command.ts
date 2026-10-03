import { ICommand } from '@nestjs/cqrs';

export class LinkGoogleCommand implements ICommand {
  constructor(
    public readonly userId: string,
    public readonly idToken: string,
    public readonly nonce: string | undefined,
    /** Needed when the account has a password: proves it is the owner, not just a stolen token. */
    public readonly currentPassword: string | undefined,
  ) {}
}
