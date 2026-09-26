import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { UpdateProductCommand } from './update-product.command.js';
import { Product, CatalogDomainException } from '../../domain/index.js';
import type { IProductRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(UpdateProductCommand)
export class UpdateProductHandler implements ICommandHandler<UpdateProductCommand> {
  private readonly logger = new Logger(UpdateProductHandler.name);

  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  async execute(command: UpdateProductCommand): Promise<Product> {
    this.logger.log(
      `Executing UpdateProductCommand for product: ${command.id}`,
    );

    const product = await this.productRepo.findById(command.id);
    if (!product) {
      throw new CatalogDomainException(
        CatalogErrorCodes.PRODUCT_NOT_FOUND,
        `Product with ID ${command.id} not found`,
      );
    }

    product.updateDetails(command.name, command.description, command.thumbnail);

    await this.productRepo.save(product);
    this.logger.log(
      `Successfully updated product details for ID: ${product.id}`,
    );

    return product;
  }
}
