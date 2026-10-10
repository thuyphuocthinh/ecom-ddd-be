import { registerAs, type ConfigType } from '@nestjs/config';

/**
 * Inventory settings, parsed once at boot. `validateEnv` has already guaranteed that every
 * value that is set is a whole number in range, so nothing downstream re-parses env strings.
 * Everything is kept in seconds inside the code; tests override this object with small values.
 */
export const inventoryConfig = registerAs('inventory', () => ({
  // How long stock is held for an unpaid order. One value for the whole system, so one delay
  // queue is enough for the "give the stock back" timer.
  reservationTtlSeconds: Number(process.env.RESERVATION_TTL_MINUTES ?? 15) * 60,
  // How often the periodic sweep (expired holds, leaked holds) runs. 0 switches it off.
  maintenanceIntervalSeconds: Number(
    process.env.INVENTORY_MAINTENANCE_INTERVAL_SECONDS ?? 60,
  ),
  // How old a "being held" record must be before it counts as left behind by a dead process.
  // Must be longer than the slowest reservation request.
  inflightGraceSeconds: Number(
    process.env.INVENTORY_INFLIGHT_GRACE_SECONDS ?? 120,
  ),
}));

export type InventoryConfig = ConfigType<typeof inventoryConfig>;
