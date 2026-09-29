import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaUserRepository } from './infrastructure/database/prisma-user.repository.js';
import { GetMeHandler } from './application/queries/get-me.handler.js';
import { UserController } from './presentation/controllers/user.controller.js';

@Module({
  imports: [CqrsModule],
  controllers: [UserController],
  providers: [
    {
      provide: 'IUserRepository',
      useClass: PrismaUserRepository,
    },
    GetMeHandler,
  ],
  exports: ['IUserRepository'], // Export cho AuthModule dùng
})
export class UsersModule {}
