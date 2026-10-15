import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  GetCatalogSitemapQuery,
  type SitemapEntry,
} from '../../application/index.js';

@ApiTags('Catalog - SEO')
@Controller('catalog')
export class CatalogSitemapController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get('sitemap-data')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get catalog sitemap data for SSR & search engine indexing',
    description:
      'Returns all active categories and published products with their slug, lastmod, changefreq, and priority for Next.js sitemap.xml generation.',
  })
  @ApiResponse({
    status: 200,
    description: 'Sitemap data retrieved successfully',
  })
  async getSitemapData(): Promise<SitemapEntry[]> {
    return this.queryBus.execute<GetCatalogSitemapQuery, SitemapEntry[]>(
      new GetCatalogSitemapQuery(),
    );
  }
}
