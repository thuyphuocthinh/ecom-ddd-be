import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { AddSkuCommand } from './add-sku.command.js';
import { Product, Sku, CatalogDomainException } from '../../domain/index.js';
import type { IProductRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@CommandHandler(AddSkuCommand)
export class AddSkuHandler implements ICommandHandler<AddSkuCommand> {
  private readonly logger = new Logger(AddSkuHandler.name);

  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  async execute(command: AddSkuCommand): Promise<Sku> {
    this.logger.log(
      `Executing AddSkuCommand for product: ${command.productId}`,
    );

    const product = await this.productRepo.findById(command.productId);
    if (!product) {
      throw new CatalogDomainException(
        CatalogErrorCodes.PRODUCT_NOT_FOUND,
        `Product with ID ${command.productId} not found`,
      );
    }

    const newSku = product.addSku({
      price: command.price,
      attributes: command.attributes,
      skuCode: command.skuCode,
      barcode: command.barcode,
    });

    await this.productRepo.save(product);
    this.logger.log(
      `Successfully added SKU with ID: ${newSku.id} to Product: ${product.id}`,
    );

    return newSku;
  }
}
