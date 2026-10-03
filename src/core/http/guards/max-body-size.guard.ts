import {
  CanActivate,
  ExecutionContext,
  PayloadTooLargeException,
  Type,
  mixin,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Refuses a request whose announced size (the Content-Length header) is over the limit, before
 * the body is read at all. An upload endpoint needs this: the upload library only stops a file
 * after it started reading it, and on an error it still reads the rest of the body to the end.
 * A request that does not announce its size is still bounded by the upload library's own limits.
 *
 * Usage: `@UseGuards(MaxBodySizeGuard(2 * 1024 * 1024 + 8 * 1024))`, a little above the largest
 * file to leave room for the multipart framing.
 */
export function MaxBodySizeGuard(maxBytes: number): Type<CanActivate> {
  class MaxBodySizeGuardMixin implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<Request>();
      const announced = Number(request.headers['content-length']);
      if (Number.isFinite(announced) && announced > maxBytes) {
        throw new PayloadTooLargeException('Request body too large');
      }
      return true;
    }
  }
  return mixin(MaxBodySizeGuardMixin);
}
