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
} from '@nestjs/swagger';
import { CreateCategoryDto } from '../dtos/create-category.dto.js';
import { MoveCategoryDto } from '../dtos/move-category.dto.js';
import { CategoryMapper } from '../mappers/category.mapper.js';
import {
  CreateCategoryCommand,
  GetCategoriesQuery,
  DeleteCategoryCommand,
  MoveCategoryCommand,
} from '../../application/index.js';
import { Category } from '../../domain/index.js';

@ApiTags('Catalog - Categories')
@Controller('catalog/categories')
export class CategoryController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
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

  @Delete(':id')
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

  @Patch(':id/move')
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
}
