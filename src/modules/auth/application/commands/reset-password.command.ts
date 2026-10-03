import { ICommand } from '@nestjs/cqrs';
import type { IClientInfo } from '@/core/index.js';

export class ResetPasswordCommand implements ICommand {
  constructor(
    public readonly email: string,
    public readonly code: string,
    public readonly newPassword: string,
    public readonly client: IClientInfo,
  ) {}
}
