import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { CreateProductCommand } from './create-product.command.js';
import { Product, CatalogDomainException } from '../../domain/index.js';
import type {
  IProductRepository,
  ICategoryRepository,
} from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(CreateProductCommand)
export class CreateProductHandler implements ICommandHandler<CreateProductCommand> {
  private readonly logger = new Logger(CreateProductHandler.name);

  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
    @Inject('ICategoryRepository')
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async execute(command: CreateProductCommand): Promise<Product> {
    this.logger.log(
      `Executing CreateProductCommand for product: ${command.name}`,
    );
    // 1. Validate Category exists
    const category = await this.categoryRepo.findById(command.categoryId);
    if (!category) {
      throw new CatalogDomainException(
        CatalogErrorCodes.CATEGORY_NOT_FOUND,
        `Category with ID ${command.categoryId} not found`,
      );
    }

    // 2. Create Product Aggregate Root
    const product = Product.create({
      categoryId: command.categoryId,
      name: command.name,
      description: command.description,
      thumbnail: command.thumbnail,
    });

    // 3. Add SKUs if provided
    if (command.skus && command.skus.length > 0) {
      for (const sku of command.skus) {
        product.addSku(sku);
      }
    }

    // 4. Save to DB
    await this.productRepo.save(product);
    this.logger.log(`Successfully created product with ID: ${product.id}`);

    return product;
  }
}
