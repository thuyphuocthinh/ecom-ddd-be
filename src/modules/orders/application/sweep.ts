export const SWEEP_BATCH_SIZE = 100;
// A round never loops for long, even if some order keeps failing: the next round continues
export const SWEEP_MAX_BATCHES = 10;
/**
 * How old a half-done order must be before a sweep touches it, so that the sweep does not step on
 * the request that is still working on it right now.
 */
export const SWEEP_GRACE_SECONDS = 30;

/**
 * The shape of every sweep: ask for a batch of order ids, handle them one by one (a failure on one
 * is reported and does not stop the others), and ask again while batches come back full.
 * `handle` returns whether it changed anything. Returns how many orders were changed.
 */
export async function sweepInBatches(
  find: (limit: number) => Promise<string[]>,
  handle: (orderId: string) => Promise<boolean>,
  onError: (orderId: string, error: Error) => void,
): Promise<number> {
  let changed = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const orderIds = await find(SWEEP_BATCH_SIZE);
    for (const orderId of orderIds) {
      try {
        if (await handle(orderId)) changed++;
      } catch (error) {
        onError(orderId, error as Error);
      }
    }
    if (orderIds.length < SWEEP_BATCH_SIZE) break;
  }
  return changed;
}
