import { ConsoleLogger, Injectable, LogLevel } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';

@Injectable()
export class AppLogger extends ConsoleLogger {
  protected formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const cls = ClsServiceManager.getClsService();
    let tracePrefix = '';

    // cls.getId() might be undefined during application bootstrap
    // or when the logger is called outside of an HTTP request context.
    if (cls && cls.isActive() && cls.getId()) {
      tracePrefix = this.colorize(`[TraceId-${cls.getId()}]`, logLevel) + ' ';
    }

    const originalMessage = super.formatMessage(
      logLevel,
      message,
      pidMessage,
      formattedLogLevel,
      contextMessage,
      timestampDiff,
    );

    return `${tracePrefix}${originalMessage}`;
  }
}
