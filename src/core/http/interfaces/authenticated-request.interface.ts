import { Request } from 'express';
import { ICurrentUser } from '../decorators/current-user.decorator.js';

/**
 * Extends express Request with auth context populated by JwtAuthGuard.
 */
export interface AuthenticatedRequest extends Request {
  user: ICurrentUser;
  token: string;
  tokenExp: number;
}
