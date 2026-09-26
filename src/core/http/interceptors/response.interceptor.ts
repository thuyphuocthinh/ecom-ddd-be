import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

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
