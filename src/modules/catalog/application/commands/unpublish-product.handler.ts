import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { UnpublishProductCommand } from './unpublish-product.command.js';
import { Product, CatalogDomainException } from '../../domain/index.js';
import type { IProductRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(UnpublishProductCommand)
export class UnpublishProductHandler implements ICommandHandler<UnpublishProductCommand> {
  private readonly logger = new Logger(UnpublishProductHandler.name);

  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  async execute(command: UnpublishProductCommand): Promise<Product> {
    this.logger.log(
      `Executing UnpublishProductCommand for product: ${command.id}`,
    );

    const product = await this.productRepo.findById(command.id);
    if (!product) {
      throw new CatalogDomainException(
        CatalogErrorCodes.PRODUCT_NOT_FOUND,
        `Product with ID ${command.id} not found`,
      );
    }

    product.unpublish();

    await this.productRepo.save(product);
    this.logger.log(`Successfully unpublished product with ID: ${product.id}`);

    return product;
  }
}
