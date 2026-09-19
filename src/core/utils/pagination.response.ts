export class PaginationMeta {
  hasNextPage!: boolean;
  hasPreviousPage!: boolean;
  nextCursor?: string;
  previousCursor?: string;
  total?: number;
}

export class PaginatedResponse<T> {
  data!: T[];
  meta!: PaginationMeta;
}

export function createPaginatedResponse<T>(
  data: T[],
  meta: PaginationMeta,
): PaginatedResponse<T> {
  return {
    data,
    meta,
  };
}
