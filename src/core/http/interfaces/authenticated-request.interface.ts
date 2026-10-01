import { Request } from 'express';
import { ICurrentUser } from '../decorators/current-user.decorator.js';

/**
 * Extends express Request with auth context populated by JwtAuthGuard.
 * `user.sid` identifies the session the access token was issued for.
 */
export interface AuthenticatedRequest extends Request {
  user: ICurrentUser;
}
