import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Param,
  HttpCode,
  HttpStatus,
  Delete,
  Patch,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { CreateProductDto } from '../dtos/create-product.dto.js';
import { CreateCategoryDto } from '../dtos/create-category.dto.js';
import { MoveCategoryDto } from '../dtos/move-category.dto.js';
import { GetProductsDto } from '../dtos/get-products.dto.js';
import {
  CreateProductCommand,
  GetProductsQuery,
  GetProductByIdQuery,
  CreateCategoryCommand,
  GetCategoriesQuery,
  DeleteCategoryCommand,
  MoveCategoryCommand,
  PublishProductCommand,
} from '../../application/index.js';
import { ProductMapper } from '../mappers/product.mapper.js';
import { CategoryMapper } from '../mappers/category.mapper.js';
import { ProductResponseDto } from '../dtos/product-response.dto.js';
import { Product, Category } from '../../domain/index.js';
import { PaginatedResult, PaginatedResponseDto } from '@/core/index.js';

@ApiTags('Catalog')
@Controller('catalog')
@ApiExtraModels(PaginatedResponseDto, ProductResponseDto)
export class CatalogController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  // ================= PRODUCTS =================

  @Post('products')
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

  @Get('products')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get list of products' })
  // @ApiQuery tags for limit, cursor, categoryId are automatically handled by the DTO structure if we use @Query()
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

  @Get('products/:id')
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

  // ================= CATEGORIES =================

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new category' })
  @ApiResponse({ status: 201, description: 'Category created successfully' })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  async createCategory(@Body() dto: CreateCategoryDto) {
    const command = new CreateCategoryCommand(dto.name, dto.parentId);
    const category = await this.commandBus.execute<
      CreateCategoryCommand,
      Category
    >(command);
    return CategoryMapper.toResponse(category);
  }

  @Get('categories')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get list of categories' })
  @ApiQuery({
    name: 'parentId',
    required: false,
    type: String,
    description:
      'ID of parent category to fetch children. Leave empty to fetch root categories.',
  })
  @ApiResponse({
    status: 200,
    description: 'Categories retrieved successfully',
  })
  async getCategories(@Query('parentId') parentId?: string) {
    const query = new GetCategoriesQuery(parentId);
    const categories = await this.queryBus.execute<
      GetCategoriesQuery,
      Category[]
    >(query);
    return categories.map(CategoryMapper.toResponse);
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a category' })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiResponse({ status: 204, description: 'Category deleted successfully' })
  @ApiResponse({
    status: 400,
    description: 'Cannot delete category containing products',
  })
  @ApiResponse({ status: 404, description: 'Category not found' })
  async deleteCategory(@Param('id') id: string) {
    const command = new DeleteCategoryCommand(id);
    await this.commandBus.execute(command);
  }

  @Patch('categories/:id/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move a category to a new parent' })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiResponse({ status: 200, description: 'Category moved successfully' })
  @ApiResponse({ status: 404, description: 'Category or New Parent not found' })
  async moveCategory(@Param('id') id: string, @Body() dto: MoveCategoryDto) {
    const command = new MoveCategoryCommand(id, dto.newParentId || null);
    const category = await this.commandBus.execute<
      MoveCategoryCommand,
      Category
    >(command);
    return CategoryMapper.toResponse(category);
  }

  @Patch('products/:id/publish')
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
