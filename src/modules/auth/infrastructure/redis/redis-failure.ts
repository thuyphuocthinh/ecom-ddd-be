import { Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Runs a Redis operation and turns any failure into a 503. The verification stores
 * hold state that decides whether a code is valid, so a Redis error must never be
 * mistaken for "no such code" or silently skipped; the caller sees "try again later".
 */
export async function orServiceUnavailable<T>(
  logger: Logger,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    logger.error(`Redis operation failed: ${error.message}`);
    throw new ServiceUnavailableException(
      'Verification service temporarily unavailable',
    );
  }
}
