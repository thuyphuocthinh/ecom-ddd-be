import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Param,
  Headers,
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
  ApiHeader,
} from '@nestjs/swagger';
import { CreateCategoryDto } from '../dtos/create-category.dto.js';
import { MoveCategoryDto } from '../dtos/move-category.dto.js';
import { UpdateCategoryDto } from '../dtos/update-category.dto.js';
import { CategoryMapper } from '../mappers/category.mapper.js';
import {
  CreateCategoryCommand,
  GetCategoriesQuery,
  DeleteCategoryCommand,
  MoveCategoryCommand,
  UpdateCategoryCommand,
  GetCategoryByIdQuery,
} from '../../application/index.js';
import { Category } from '../../domain/index.js';
import {
  IdempotencyService,
  computeIdempotencyFingerprint,
} from '@/core/index.js';

@ApiTags('Catalog - Categories')
@Controller('catalog/categories')
export class CategoryController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new category' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional client-generated key. Retrying the same key within 24h replays the original response instead of creating a duplicate category.',
  })
  @ApiResponse({ status: 201, description: 'Category created successfully' })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 409,
    description: 'A request with this Idempotency-Key is already in progress',
  })
  async createCategory(
    @Body() dto: CreateCategoryDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotencyService.execute(
      idempotencyKey,
      computeIdempotencyFingerprint(dto),
      async () => {
        const command = new CreateCategoryCommand(dto.name, dto.parentId);
        const category = await this.commandBus.execute<
          CreateCategoryCommand,
          Category
        >(command);
        return CategoryMapper.toResponse(category);
      },
    );
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

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update category details' })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiResponse({ status: 200, description: 'Category updated successfully' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  async updateCategory(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    const command = new UpdateCategoryCommand(id, dto.name, dto.isActive);
    const category = await this.commandBus.execute<
      UpdateCategoryCommand,
      Category
    >(command);
    return CategoryMapper.toResponse(category);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a category' })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiResponse({ status: 204, description: 'Category deleted successfully' })
  @ApiResponse({
    status: 409,
    description:
      'Cannot delete category containing products or child categories',
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
