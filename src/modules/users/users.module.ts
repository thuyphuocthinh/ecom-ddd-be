import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaUserRepository } from './infrastructure/database/prisma-user.repository.js';
import { GetMeHandler } from './application/queries/get-me.handler.js';
import { UpdateProfileHandler } from './application/commands/update-profile.handler.js';
import { UploadAvatarHandler } from './application/commands/upload-avatar.handler.js';
import { RemoveAvatarHandler } from './application/commands/remove-avatar.handler.js';
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
    UpdateProfileHandler,
    UploadAvatarHandler,
    RemoveAvatarHandler,
  ],
  exports: ['IUserRepository'], // Export cho AuthModule dùng
})
export class UsersModule {}
