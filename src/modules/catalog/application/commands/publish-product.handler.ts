import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { PublishProductCommand } from './publish-product.command.js';
import { Product, CatalogDomainException } from '../../domain/index.js';
import type { IProductRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(PublishProductCommand)
export class PublishProductHandler implements ICommandHandler<PublishProductCommand> {
  private readonly logger = new Logger(PublishProductHandler.name);

  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  async execute(command: PublishProductCommand): Promise<Product> {
    this.logger.log(`Executing PublishProductCommand for ID: ${command.id}`);
    const product = await this.productRepo.findById(command.id);
    if (!product) {
      throw new CatalogDomainException(
        CatalogErrorCodes.PRODUCT_NOT_FOUND,
        `Product with ID ${command.id} not found`,
      );
    }

    product.publish();
    await this.productRepo.save(product);
    this.logger.log(`Successfully published product: ${product.id}`);

    return product;
  }
}
