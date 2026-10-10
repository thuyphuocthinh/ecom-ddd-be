export interface StockSnapshot {
  /** Units physically in the warehouse. */
  onHand: number;
  /** Units held by reservations that are still RESERVED. */
  reserved: number;
}

export interface IStockRepository {
  /** What the database says about a SKU, read in one consistent step; null when it has no stock row. */
  getSnapshot(skuId: string): Promise<StockSnapshot | null>;
}
