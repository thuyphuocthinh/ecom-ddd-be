import { ICommand } from '@nestjs/cqrs';
import type { IClientInfo } from '@/core/index.js';

export class LoginCommand implements ICommand {
  constructor(
    public readonly email: string,
    public readonly plainPassword: string,
    public readonly client: IClientInfo,
  ) {}
}
