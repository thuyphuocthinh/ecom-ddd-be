import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface IClientInfo {
  /** Client IP as Express resolves it (`request.ip`). */
  ip: string;
  /** Raw `User-Agent` header, empty when the client sends none. */
  userAgent: string;
}

/**
 * The calling client's IP and User-Agent, for recording which device a session
 * belongs to. Both are client-controlled input: use them for display, never
 * for an access decision.
 */
export const ClientInfo = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): IClientInfo => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return {
      ip: request.ip ?? '',
      userAgent: request.headers['user-agent'] ?? '',
    };
  },
);
