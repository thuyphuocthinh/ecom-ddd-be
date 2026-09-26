import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { UpdateSkuPriceCommand } from './update-sku-price.command.js';
import { Product, Price, CatalogDomainException } from '../../domain/index.js';
import type { IProductRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(UpdateSkuPriceCommand)
export class UpdateSkuPriceHandler implements ICommandHandler<UpdateSkuPriceCommand> {
  private readonly logger = new Logger(UpdateSkuPriceHandler.name);

  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  async execute(command: UpdateSkuPriceCommand): Promise<Product> {
    this.logger.log(
      `Executing UpdateSkuPriceCommand for product: ${command.productId}, sku: ${command.skuId}`,
    );

    const product = await this.productRepo.findById(command.productId);
    if (!product) {
      throw new CatalogDomainException(
        CatalogErrorCodes.PRODUCT_NOT_FOUND,
        `Product with ID ${command.productId} not found`,
      );
    }

    product.updateSkuPrice(command.skuId, Price.create(command.price));

    await this.productRepo.save(product);
    this.logger.log(
      `Successfully updated SKU price for ID: ${command.skuId} in Product: ${product.id}`,
    );

    return product;
  }
}
