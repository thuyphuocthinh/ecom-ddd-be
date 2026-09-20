import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { MoveCategoryCommand } from './move-category.command.js';
import { Category, CatalogDomainException } from '../../domain/index.js';
import type { ICategoryRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(MoveCategoryCommand)
export class MoveCategoryHandler implements ICommandHandler<MoveCategoryCommand> {
  private readonly logger = new Logger(MoveCategoryHandler.name);

  constructor(
    @Inject('ICategoryRepository')
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async execute(command: MoveCategoryCommand): Promise<Category> {
    this.logger.log(
      `Executing MoveCategoryCommand for category: ${command.id}`,
    );
    const category = await this.categoryRepo.findById(command.id);
    if (!category) {
      throw new CatalogDomainException(
        CatalogErrorCodes.CATEGORY_NOT_FOUND,
        `Category with ID ${command.id} not found`,
      );
    }

    let newParent: Category | null = null;
    if (command.newParentId) {
      newParent = await this.categoryRepo.findById(command.newParentId);
      if (!newParent) {
        throw new CatalogDomainException(
          CatalogErrorCodes.CATEGORY_NOT_FOUND,
          `New parent category with ID ${command.newParentId} not found`,
        );
      }
    }

    const oldPath = category.path;
    category.moveTo(newParent);

    // Update path and all children's paths in database
    await this.categoryRepo.updatePathAndChildren(category, oldPath);
    this.logger.log(
      `Successfully moved category ${category.id} to new path: ${category.path}`,
    );

    return category;
  }
}
