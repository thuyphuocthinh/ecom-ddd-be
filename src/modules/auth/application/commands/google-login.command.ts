import { ICommand } from '@nestjs/cqrs';
import type { IClientInfo } from '@/core/index.js';

export class GoogleLoginCommand implements ICommand {
  constructor(
    public readonly idToken: string,
    public readonly nonce: string | undefined,
    public readonly client: IClientInfo,
  ) {}
}
