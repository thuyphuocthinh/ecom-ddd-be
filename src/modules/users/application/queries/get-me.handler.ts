import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { GetMeQuery } from './get-me.query.js';
import { User, UserDomainException } from '../../domain/index.js';
import type { IUserRepository } from '../../domain/index.js';
import { UserErrorCodes } from '@/core/domain/exceptions/error-codes.js';

@QueryHandler(GetMeQuery)
export class GetMeHandler implements IQueryHandler<GetMeQuery> {
  private readonly logger = new Logger(GetMeHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepository,
  ) {}

  async execute(query: GetMeQuery): Promise<User> {
    this.logger.debug(`Executing GetMeQuery for user: ${query.userId}`);

    const user = await this.userRepo.findById(query.userId);
    if (!user) {
      throw new UserDomainException(
        UserErrorCodes.USER_NOT_FOUND,
        `User with ID ${query.userId} not found`,
      );
    }

    return user;
  }
}
