import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { CreateCategoryCommand } from './create-category.command.js';
import { Category, CatalogDomainException } from '../../domain/index.js';
import type { ICategoryRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(CreateCategoryCommand)
export class CreateCategoryHandler implements ICommandHandler<CreateCategoryCommand> {
  private readonly logger = new Logger(CreateCategoryHandler.name);

  constructor(
    @Inject('ICategoryRepository')
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async execute(command: CreateCategoryCommand): Promise<Category> {
    this.logger.log(
      `Executing CreateCategoryCommand for category: ${command.name}`,
    );
    let parentCategory: Category | null = null;

    if (command.parentId) {
      parentCategory = await this.categoryRepo.findById(command.parentId);
      if (!parentCategory) {
        throw new CatalogDomainException(
          CatalogErrorCodes.CATEGORY_NOT_FOUND,
          `Parent category with ID ${command.parentId} not found`,
        );
      }
    }

    const category = Category.create(command.name, parentCategory);

    await this.categoryRepo.save(category);
    this.logger.log(`Successfully created category with ID: ${category.id}`);

    return category;
  }
}
