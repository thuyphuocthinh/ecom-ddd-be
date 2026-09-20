import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { DeleteCategoryCommand } from './delete-category.command.js';
import { CatalogDomainException } from '../../domain/index.js';
import type { ICategoryRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(DeleteCategoryCommand)
export class DeleteCategoryHandler implements ICommandHandler<DeleteCategoryCommand> {
  private readonly logger = new Logger(DeleteCategoryHandler.name);

  constructor(
    @Inject('ICategoryRepository')
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async execute(command: DeleteCategoryCommand): Promise<void> {
    this.logger.log(`Executing DeleteCategoryCommand for ID: ${command.id}`);
    const category = await this.categoryRepo.findById(command.id);
    if (!category) {
      throw new CatalogDomainException(
        CatalogErrorCodes.CATEGORY_NOT_FOUND,
        `Category with ID ${command.id} not found`,
      );
    }

    const hasProducts = await this.categoryRepo.hasProducts(command.id);
    if (hasProducts) {
      throw new CatalogDomainException(CatalogErrorCodes.CATEGORY_HAS_PRODUCTS);
    }

    await this.categoryRepo.delete(command.id);
    this.logger.log(`Successfully deleted category: ${command.id}`);
  }
}
