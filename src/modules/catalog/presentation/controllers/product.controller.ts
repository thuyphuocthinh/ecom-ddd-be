import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Param,
  HttpCode,
  HttpStatus,
  Patch,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { CreateProductDto } from '../dtos/create-product.dto.js';
import { GetProductsDto } from '../dtos/get-products.dto.js';
import { ProductResponseDto } from '../dtos/product-response.dto.js';
import { ProductMapper } from '../mappers/product.mapper.js';
import {
  CreateProductCommand,
  GetProductsQuery,
  GetProductByIdQuery,
  PublishProductCommand,
} from '../../application/index.js';
import { Product } from '../../domain/index.js';
import { PaginatedResult, PaginatedResponseDto } from '@/core/index.js';

@ApiTags('Catalog - Products')
@Controller('catalog/products')
@ApiExtraModels(PaginatedResponseDto, ProductResponseDto)
export class ProductController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new product' })
  @ApiResponse({ status: 201, description: 'Product created successfully' })
  @ApiResponse({ status: 400, description: 'Bad Request / Validation Error' })
  async createProduct(@Body() dto: CreateProductDto) {
    const command = new CreateProductCommand(
      dto.categoryId,
      dto.name,
      dto.description,
      dto.thumbnail,
      dto.skus,
    );

    const product = await this.commandBus.execute<
      CreateProductCommand,
      Product
    >(command);
    return ProductMapper.toResponse(product);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get list of products' })
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
    );

    const result = await this.queryBus.execute<
      GetProductsQuery,
      PaginatedResult<Product>
    >(query);

    return PaginatedResponseDto.map(result, ProductMapper.toResponse);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get product by ID' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({ status: 200, description: 'Product retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async getProductById(@Param('id') id: string) {
    const query = new GetProductByIdQuery(id);
    const product = await this.queryBus.execute<GetProductByIdQuery, Product>(
      query,
    );
    return ProductMapper.toResponse(product);
  }

  @Patch(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a product' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({ status: 200, description: 'Product published successfully' })
  @ApiResponse({
    status: 400,
    description: 'Cannot publish product without SKUs or Price',
  })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async publishProduct(@Param('id') id: string) {
    const command = new PublishProductCommand(id);
    const product = await this.commandBus.execute<
      PublishProductCommand,
      Product
    >(command);
    return ProductMapper.toResponse(product);
  }
}
