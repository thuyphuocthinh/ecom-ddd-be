import {
  Controller,
  Get,
  Query,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { SearchProductsDto } from '../dtos/search-products.dto.js';
import { FacetsQueryDto } from '../dtos/facets-query.dto.js';
import {
  CategoryProductCountResponseDto,
  PageMetaResponseDto,
  ProductResponseDto,
} from '../dtos/product-response.dto.js';
import { ProductMapper } from '../mappers/product.mapper.js';
import {
  GetProductFacetsQuery,
  GetPublishedProductByIdQuery,
  SearchProductsQuery,
  GetCatalogSitemapQuery,
  type ProductSearchResult,
  type PublishedProductView,
  type SitemapEntry,
} from '../../application/index.js';
import type { CategoryProductCount } from '../../domain/index.js';
import { PaginatedResponseDto } from '@/core/index.js';

/**
 * The public storefront: no login needed, and only PUBLISHED products are ever
 * shown. Admin endpoints (including seeing draft products) live in
 * `AdminProductController`.
 */
@ApiTags('Catalog - Products')
@Controller('catalog/products')
@ApiExtraModels(
  PaginatedResponseDto,
  PageMetaResponseDto,
  ProductResponseDto,
  CategoryProductCountResponseDto,
)
export class ProductController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get list of published products',
    description:
      'Newest first unless `sort` says otherwise. Read it by `cursor` ("load more", newest only; `meta` has `hasMore` and `nextCursor`) or by `page` (a numbered page, any sort; `meta` has `page`, `limit`, `hasMore`, `total` counted up to 1000, and `totalCapped`). Each SKU and each product says whether it is in stock.',
  })
  @ApiResponse({
    status: 200,
    description: 'Products retrieved successfully',
    schema: {
      allOf: [
        { $ref: getSchemaPath(PaginatedResponseDto) },
        {
          properties: {
            data: {
              type: 'array',
              items: { $ref: getSchemaPath(ProductResponseDto) },
            },
            meta: { $ref: getSchemaPath(PageMetaResponseDto) },
          },
        },
      ],
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'A bad parameter (VAL-001), or options that cannot go together (CAT-017): page with cursor, cursor with another sort, relevance without search, a page past the first 1000 results, a cursor that is not a product',
  })
  async getProducts(@Query() dto: SearchProductsDto) {
    const { data, meta, inStockSkuIds } = await this.queryBus.execute<
      SearchProductsQuery,
      ProductSearchResult
    >(
      new SearchProductsQuery({
        limit: dto.limit,
        page: dto.page,
        cursor: dto.cursor,
        sort: dto.sort,
        categoryId: dto.categoryId,
        search: dto.search,
        minPrice: dto.minPrice,
        maxPrice: dto.maxPrice,
        inStock: dto.inStock === 'true' ? true : undefined,
        onSale: dto.onSale === 'true' ? true : undefined,
      }),
    );
    return {
      data: data.map((product) =>
        ProductMapper.toPublicResponse(product, inStockSkuIds),
      ),
      meta,
    };
  }

  // Declared BEFORE `:id`, or "facets" would be taken for a product id
  @Get('facets')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'How many published products each category holds',
    description:
      'The categories directly under `parentId` (the root categories when left out), each with the products in it and in every category below it, inside the filters.',
  })
  @ApiResponse({
    status: 200,
    type: [CategoryProductCountResponseDto],
  })
  async getFacets(
    @Query() dto: FacetsQueryDto,
  ): Promise<CategoryProductCountResponseDto[]> {
    return this.queryBus.execute<GetProductFacetsQuery, CategoryProductCount[]>(
      new GetProductFacetsQuery(dto.parentId ?? null, {
        search: dto.search,
        minPrice: dto.minPrice,
        maxPrice: dto.maxPrice,
        inStock: dto.inStock === 'true' ? true : undefined,
        onSale: dto.onSale === 'true' ? true : undefined,
      }),
    );
  }

  // Declared BEFORE `:identifier`, or "sitemap-data" would be taken for a product identifier
  @Get('sitemap-data')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get product sitemap data for SSR & search engine indexing',
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

  @Get(':identifier')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a published product by ID or slug' })
  @ApiParam({ name: 'identifier', description: 'Product ID or slug' })
  @ApiResponse({ status: 200, description: 'Product retrieved successfully' })
  @ApiResponse({
    status: 404,
    description: 'Product not found, or not published',
  })
  async getProductById(@Param('identifier') identifier: string) {
    const { product, inStockSkuIds } = await this.queryBus.execute<
      GetPublishedProductByIdQuery,
      PublishedProductView
    >(new GetPublishedProductByIdQuery(identifier));
    return ProductMapper.toPublicResponse(product, inStockSkuIds);
  }
}
