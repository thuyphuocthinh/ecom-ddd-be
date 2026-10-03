import { User } from '../../domain/index.js';
import { UserResponseDto } from '../dtos/user-response.dto.js';

export class UserMapper {
  static toResponseDto(user: User): UserResponseDto {
    return {
      id: user.id,
      role: user.role,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
      email: user.email,
      hasPassword: user.hasPassword,
      googleLinked: user.googleLinked,
    };
  }
}
