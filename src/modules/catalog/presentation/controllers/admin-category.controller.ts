import {
  Controller,
  Post,
  Body,
  Param,
  Headers,
  HttpCode,
  HttpStatus,
  Delete,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiHeader,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, Roles } from '@/core/index.js';
import { UserRole } from '@prisma/client';
import { CreateCategoryDto } from '../dtos/create-category.dto.js';
import { MoveCategoryDto } from '../dtos/move-category.dto.js';
import { UpdateCategoryDto } from '../dtos/update-category.dto.js';
import { CategoryMapper } from '../mappers/category.mapper.js';
import {
  CreateCategoryCommand,
  DeleteCategoryCommand,
  MoveCategoryCommand,
  UpdateCategoryCommand,
} from '../../application/index.js';
import { Category } from '../../domain/index.js';
import {
  IdempotencyService,
  computeIdempotencyFingerprint,
} from '@/core/index.js';

/**
 * Everything an admin does with categories. The guards sit on the class, so no
 * endpoint added here can be reached without an ADMIN token.
 */
@ApiTags('Admin - Catalog')
@ApiBearerAuth()
@Controller('admin/catalog/categories')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminCategoryController {
  constructor(
    private readonly commandBus: CommandBus,
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
