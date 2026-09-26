import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResult } from '../../domain/types/pagination.js';

export class PaginatedMetaDto {
  @ApiProperty()
  hasMore: boolean;

  @ApiProperty({ nullable: true })
  nextCursor: string | null;
}

export class PaginatedResponseDto<T> {
  // @ApiProperty for data is usually defined dynamically per controller using @ApiExtraModels
  // or a custom decorator. We'll leave the basic structure here.
  data: T[];

  @ApiProperty()
  meta: PaginatedMetaDto;

  static map<T, U>(
    result: PaginatedResult<T>,
    mapperFn: (item: T) => U,
  ): PaginatedResponseDto<U> {
    const response = new PaginatedResponseDto<U>();
    response.data = result.data.map(mapperFn);
    response.meta = result.meta;
    return response;
  }
}
