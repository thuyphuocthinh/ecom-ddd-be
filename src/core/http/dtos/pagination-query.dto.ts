import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../domain/types/pagination.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = object> = new (...args: any[]) => T;

/**
 * Adds `limit` and `cursor` to a query class, so a request that has other fields too (filters)
 * gets the same two fields and the same checks as every other list.
 */
export function WithCursorPagination<TBase extends Constructor>(Base: TBase) {
  class CursorPagination extends Base {
    @ApiPropertyOptional({
      default: DEFAULT_PAGE_SIZE,
      minimum: 1,
      maximum: MAX_PAGE_SIZE,
      description: 'Number of items per page',
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(MAX_PAGE_SIZE)
    limit: number = DEFAULT_PAGE_SIZE;

    @ApiPropertyOptional({
      description: 'The `meta.nextCursor` of the previous page',
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    cursor?: string;
  }
  return CursorPagination;
}

/**
 * Adds `page` (1, 2, 3...) to a query class, for a list that can also be read by page number.
 */
export function WithPageNumber<TBase extends Constructor>(Base: TBase) {
  class PageNumber extends Base {
    @ApiPropertyOptional({
      minimum: 1,
      description: 'Page number, starting at 1 (instead of `cursor`)',
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;
  }
  return PageNumber;
}

export class PaginationQueryDto extends WithCursorPagination(class {}) {}
