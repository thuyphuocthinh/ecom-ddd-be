/** One event waiting in the outbox. */
export interface OutboxRow {
  id: string;
  /** Order of creation, never reused. */
  seq: bigint;
  type: string;
  aggregateId: string;
  payload: unknown;
  createdAt: Date;
}

export interface ClaimResult {
  /** How many events were sent and marked as sent. */
  sent: number;
  /** The error that stopped the round, or null when every claimed event was sent. */
  failure: Error | null;
}

/**
 * The events not sent yet. Two copies of the publisher can run at once: each takes its own rows, so
 * an event is not sent twice at the same moment, and it is still sent at least once.
 */
export interface IOutboxStore {
  /**
   * Takes up to `limit` unsent events (oldest first, skipping rows another publisher holds), gives each
   * to `send` in order, and marks each as sent once `send` has returned. The first `send` that
   * fails stops the round: the events before it stay marked, that one and the rest stay unsent.
   */
  claimBatch(
    limit: number,
    send: (row: OutboxRow) => Promise<void>,
  ): Promise<ClaimResult>;
}
