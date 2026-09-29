// Guards and decorators that are cross-cutting concerns have been moved to @/core.
// Re-export them here so that auth-internal consumers (auth.module.ts, auth.controller.ts)
// can still import from this barrel if needed.
export {
  JwtAuthGuard,
  RolesGuard,
  CurrentUser,
  Roles,
  ROLES_KEY,
} from '@/core/index.js';
export type { ICurrentUser, AuthenticatedRequest } from '@/core/index.js';

export * from './dtos/index.js';
export * from './controllers/auth.controller.js';
