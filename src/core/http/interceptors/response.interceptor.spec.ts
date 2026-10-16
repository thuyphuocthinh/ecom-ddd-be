import 'reflect-metadata';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { Sse } from '@nestjs/common';
import { ResponseInterceptor, SSE_METADATA } from './response.interceptor.js';

class Controller {
  @Sse('events')
  stream() {
    return of({ data: 'x' });
  }

  plain() {
    return { id: 1 };
  }
}

function contextOf(handler: () => unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }),
  } as unknown as ExecutionContext;
}

function run(handler: () => unknown, body: unknown) {
  const next: CallHandler = { handle: () => of(body) };
  let result: unknown;
  new ResponseInterceptor()
    .intercept(contextOf(handler), next)
    .subscribe((value) => (result = value));
  return result;
}

describe('ResponseInterceptor (AC-10)', () => {
  it('uses the same key as Nest puts on an @Sse route', () => {
    expect(Reflect.getMetadata(SSE_METADATA, Controller.prototype.stream)).toBe(
      true,
    );
  });

  it('sends the messages of an @Sse route as they are', () => {
    const message = { type: 'status', data: { orderId: 'X' } };

    expect(run(Controller.prototype.stream, message)).toBe(message);
  });

  it('still wraps the other routes', () => {
    expect(run(Controller.prototype.plain, { id: 1 })).toEqual({
      statusCode: 200,
      message: 'Success',
      data: { id: 1 },
    });
  });
});
