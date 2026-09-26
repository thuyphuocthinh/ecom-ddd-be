import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { RemoveSkuCommand } from './remove-sku.command.js';
import { Product, CatalogDomainException } from '../../domain/index.js';
import type { IProductRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(RemoveSkuCommand)
export class RemoveSkuHandler implements ICommandHandler<RemoveSkuCommand> {
  private readonly logger = new Logger(RemoveSkuHandler.name);

  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  async execute(command: RemoveSkuCommand): Promise<Product> {
    this.logger.log(
      `Executing RemoveSkuCommand for product: ${command.productId}, sku: ${command.skuId}`,
    );

    const product = await this.productRepo.findById(command.productId);
    if (!product) {
      throw new CatalogDomainException(
        CatalogErrorCodes.PRODUCT_NOT_FOUND,
        `Product with ID ${command.productId} not found`,
      );
    }

    product.removeSku(command.skuId);

    await this.productRepo.save(product);
    this.logger.log(
      `Successfully removed SKU with ID: ${command.skuId} from Product: ${product.id}`,
    );

    return product;
  }
}
