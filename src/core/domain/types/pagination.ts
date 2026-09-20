export interface PaginatedMeta {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PaginatedMeta;
}
