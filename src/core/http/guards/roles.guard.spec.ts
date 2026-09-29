import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RolesGuard } from './roles.guard.js';
import { DomainException, AuthErrorCodes } from '../../index.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

const makeContext = (
  user: object | null,
  handler: () => void = () => {},
  cls: () => void = () => {},
) => {
  const req = { user } as any;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
};

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: { getAllAndOverride: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    reflector = { getAllAndOverride: vi.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('returns true when no required roles are set (public route)', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = makeContext({ id: 'u1', role: UserRole.CUSTOMER });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('returns true when user has the required role', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN]);
    const ctx = makeContext({ id: 'u1', role: UserRole.ADMIN });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws FORBIDDEN_RESOURCE when user does not have the required role', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN]);
    const ctx = makeContext({ id: 'u1', role: UserRole.CUSTOMER });
    expect(() => guard.canActivate(ctx)).toThrow(
      expect.objectContaining({
        code: AuthErrorCodes.FORBIDDEN_RESOURCE.code,
      } as Partial<DomainException>),
    );
  });

  it('throws UNAUTHORIZED_ACCESS when user is not attached to request (guard order issue)', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN]);
    const ctx = makeContext(null);
    expect(() => guard.canActivate(ctx)).toThrow(
      expect.objectContaining({
        code: AuthErrorCodes.UNAUTHORIZED_ACCESS.code,
      } as Partial<DomainException>),
    );
  });

  it('returns true when user role is one of multiple allowed roles', () => {
    reflector.getAllAndOverride.mockReturnValue([
      UserRole.ADMIN,
      UserRole.CUSTOMER,
    ]);
    const ctx = makeContext({ id: 'u1', role: UserRole.CUSTOMER });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
