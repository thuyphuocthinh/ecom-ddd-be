import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { DomainException, AuthErrorCodes } from '../../index.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';

/**
 * Checks that the authenticated user has one of the required roles.
 * Must be used AFTER JwtAuthGuard (which populates request.user).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new DomainException(
        AuthErrorCodes.UNAUTHORIZED_ACCESS,
        'User not found in request context',
      );
    }

    if (!requiredRoles.includes(user.role)) {
      throw new DomainException(
        AuthErrorCodes.FORBIDDEN_RESOURCE,
        'You do not have permission to perform this action',
      );
    }

    return true;
  }
}
