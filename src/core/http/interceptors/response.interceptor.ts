import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/** The key Nest stores on a route marked with @Sse() (`SSE_METADATA` in @nestjs/common). */
export const SSE_METADATA = '__sse__';

export interface StandardResponse<T> {
  statusCode: number;
  message: string;
  data: T;
  meta?: any;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  StandardResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<StandardResponse<T>> {
    // A server-sent-events route sends its messages as they are: wrapping each one in
    // { statusCode, message, data } would break the stream format.
    if (Reflect.getMetadata(SSE_METADATA, context.getHandler())) {
      return next.handle();
    }

    return next.handle().pipe(
      map((result) => {
        const statusCode = context.switchToHttp().getResponse().statusCode;

        if (
          result &&
          typeof result === 'object' &&
          'data' in result &&
          'meta' in result
        ) {
          const paginatedResult = result as any;
          return {
            statusCode,
            message: 'Success',
            data: paginatedResult.data,
            meta: paginatedResult.meta,
          } as StandardResponse<T>;
        }

        return {
          statusCode,
          message: 'Success',
          data: result,
        } as StandardResponse<T>;
      }),
    );
  }
}
