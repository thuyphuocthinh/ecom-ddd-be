import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { RegisterCommand } from './register.command.js';
import { User, UserDomainException } from '../../../users/domain/index.js';
import type { IUserRepository as IUserRepositoryType } from '../../../users/domain/index.js';
import { UserErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import { CredentialProvider } from '@prisma/client';
import { randomUUID } from 'crypto';

@CommandHandler(RegisterCommand)
export class RegisterHandler implements ICommandHandler<RegisterCommand> {
  private readonly logger = new Logger(RegisterHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
  ) {}

  async execute(command: RegisterCommand): Promise<User> {
    this.logger.debug('Executing RegisterCommand');

    // 1. Check if user already exists.
    // Not race-free on its own: two concurrent registrations can both pass this
    // check, so the repository also maps the unique-constraint violation to the same error.
    const existingUser = await this.userRepo.findByCredential(
      CredentialProvider.EMAIL,
      command.email,
    );
    if (existingUser) {
      throw new UserDomainException(
        UserErrorCodes.EMAIL_ALREADY_EXISTS,
        'Email is already registered',
      );
    }

    // 2. Hash password
    const passwordHash = await HashUtil.hashPassword(command.plainPassword);

    // 3. Create User entity
    const userId = randomUUID();
    const user = User.create(userId, undefined, command.displayName);

    const credentialId = randomUUID();
    user.addCredential(
      credentialId,
      CredentialProvider.EMAIL,
      command.email,
      passwordHash,
    );

    // 4. Save to DB
    await this.userRepo.save(user);

    return user;
  }
}
