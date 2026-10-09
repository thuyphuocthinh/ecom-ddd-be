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
import { GetProductsDto } from '../dtos/get-products.dto.js';
import { ProductResponseDto } from '../dtos/product-response.dto.js';
import { ProductMapper } from '../mappers/product.mapper.js';
import {
  GetProductsQuery,
  GetPublishedProductByIdQuery,
} from '../../application/index.js';
import { Product, ProductStatus } from '../../domain/index.js';
import { PaginatedResult, PaginatedResponseDto } from '@/core/index.js';

/**
 * The public storefront: no login needed, and only PUBLISHED products are ever
 * shown. Admin endpoints (including seeing draft products) live in
 * `AdminProductController`.
 */
@ApiTags('Catalog - Products')
@Controller('catalog/products')
@ApiExtraModels(PaginatedResponseDto, ProductResponseDto)
export class ProductController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get list of published products' })
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
          },
        },
      ],
    },
  })
  async getProducts(@Query() queryDto: GetProductsDto) {
    const query = new GetProductsQuery(
      queryDto.limit,
      queryDto.cursor,
      queryDto.categoryId,
      queryDto.search,
      ProductStatus.PUBLISHED, // fixed here: the customer cannot choose it
      queryDto.minPrice,
      queryDto.maxPrice,
    );

    const result = await this.queryBus.execute<
      GetProductsQuery,
      PaginatedResult<Product>
    >(query);

    return PaginatedResponseDto.map(result, ProductMapper.toResponse);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a published product by ID' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({ status: 200, description: 'Product retrieved successfully' })
  @ApiResponse({
    status: 404,
    description: 'Product not found, or not published',
  })
  async getProductById(@Param('id') id: string) {
    const query = new GetPublishedProductByIdQuery(id);
    const product = await this.queryBus.execute<
      GetPublishedProductByIdQuery,
      Product
    >(query);
    return ProductMapper.toResponse(product);
  }
}
