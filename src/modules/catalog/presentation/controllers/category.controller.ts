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
  ApiQuery,
} from '@nestjs/swagger';
import { CategoryMapper } from '../mappers/category.mapper.js';
import {
  GetCategoriesQuery,
  GetCategoryByIdQuery,
} from '../../application/index.js';
import { Category } from '../../domain/index.js';

/**
 * The public category tree: no login needed. Admin endpoints live in
 * `AdminCategoryController`.
 */
@ApiTags('Catalog - Categories')
@Controller('catalog/categories')
export class CategoryController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get()
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

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get category by ID' })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiResponse({ status: 200, description: 'Category retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  async getCategoryById(@Param('id') id: string) {
    const query = new GetCategoryByIdQuery(id);
    const category = await this.queryBus.execute<
      GetCategoryByIdQuery,
      Category
    >(query);
    return CategoryMapper.toResponse(category);
  }
}
