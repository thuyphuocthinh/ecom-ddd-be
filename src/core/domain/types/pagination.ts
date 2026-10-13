export interface PaginatedMeta {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PaginatedMeta;
}

/** The page size when a request does not say, and the most a request may ask for. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * A page read by position in a list ("page 3"): `total` is how many rows match, counted only up
 * to a ceiling, and `totalCapped` says that more than that match.
 */
export interface PageMeta {
  page: number;
  limit: number;
  hasMore: boolean;
  total: number;
  totalCapped: boolean;
}

export interface PagedResult<T> {
  data: T[];
  meta: PageMeta;
}

/**
 * Turns the rows of a keyset query into a page. Ask the database for `limit + 1` rows: the extra
 * one is only there to tell whether there is a next page, it is cut off here, and the key of the
 * last row that is kept becomes the cursor of the next page.
 */
export function toCursorPage<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => string,
): PaginatedResult<T> {
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  return {
    data,
    meta: {
      hasMore,
      nextCursor: hasMore ? cursorOf(data[data.length - 1]) : null,
    },
  };
}

/** Turns the rows of one numbered page, with the (capped) total, into a page. */
export function toPage<T>(
  rows: readonly T[],
  position: {
    page: number;
    limit: number;
    total: number;
    totalCapped: boolean;
  },
): PagedResult<T> {
  const { page, limit, total, totalCapped } = position;
  return {
    data: [...rows],
    meta: { page, limit, hasMore: page * limit < total, total, totalCapped },
  };
}
