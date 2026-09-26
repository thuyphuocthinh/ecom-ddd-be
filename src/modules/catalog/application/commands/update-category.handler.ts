import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { UpdateCategoryCommand } from './update-category.command.js';
import { Category, CatalogDomainException } from '../../domain/index.js';
import type { ICategoryRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(UpdateCategoryCommand)
export class UpdateCategoryHandler implements ICommandHandler<UpdateCategoryCommand> {
  private readonly logger = new Logger(UpdateCategoryHandler.name);

  constructor(
    @Inject('ICategoryRepository')
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async execute(command: UpdateCategoryCommand): Promise<Category> {
    this.logger.log(
      `Executing UpdateCategoryCommand for category: ${command.id}`,
    );

    const category = await this.categoryRepo.findById(command.id);
    if (!category) {
      throw new CatalogDomainException(
        CatalogErrorCodes.CATEGORY_NOT_FOUND,
        `Category with ID ${command.id} not found`,
      );
    }

    category.updateDetails(command.name, command.isActive);

    await this.categoryRepo.save(category);
    this.logger.log(
      `Successfully updated category details for ID: ${category.id}`,
    );

    return category;
  }
}
