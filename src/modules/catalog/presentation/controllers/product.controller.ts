import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Param,
  HttpCode,
  HttpStatus,
  Delete,
  Patch,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { CreateProductDto } from '../dtos/create-product.dto.js';
import { GetProductsDto } from '../dtos/get-products.dto.js';
import { UpdateProductDto } from '../dtos/update-product.dto.js';
import { AddSkuDto } from '../dtos/add-sku.dto.js';
import { UpdateSkuPriceDto } from '../dtos/update-sku-price.dto.js';
import { ProductResponseDto } from '../dtos/product-response.dto.js';
import { ProductMapper } from '../mappers/product.mapper.js';
import {
  CreateProductCommand,
  GetProductsQuery,
  GetProductByIdQuery,
  UpdateProductCommand,
  PublishProductCommand,
  UnpublishProductCommand,
  AddSkuCommand,
  RemoveSkuCommand,
  UpdateSkuPriceCommand,
} from '../../application/index.js';
import { Product, Sku } from '../../domain/index.js';
import { PaginatedResult, PaginatedResponseDto } from '@/core/index.js';

@ApiTags('Catalog - Products')
@Controller('catalog/products')
@ApiExtraModels(PaginatedResponseDto, ProductResponseDto)
export class ProductController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new product' })
  @ApiResponse({ status: 201, description: 'Product created successfully' })
  @ApiResponse({ status: 400, description: 'Bad Request / Validation Error' })
  async createProduct(@Body() dto: CreateProductDto) {
    const command = new CreateProductCommand(
      dto.categoryId,
      dto.name,
      dto.description,
      dto.thumbnail,
      dto.skus,
    );

    const product = await this.commandBus.execute<
      CreateProductCommand,
      Product
    >(command);
    return ProductMapper.toResponse(product);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update product details' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({ status: 200, description: 'Product updated successfully' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    const command = new UpdateProductCommand(
      id,
      dto.name,
      dto.description,
      dto.thumbnail,
    );
    const product = await this.commandBus.execute<
      UpdateProductCommand,
      Product
    >(command);
    return ProductMapper.toResponse(product);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get list of products' })
  @ApiResponse({
    status: 200,
    description: 'Products retrieved successfully',
    schema: {
      allOf: [
        { $ref: getSchemaPath(PaginatedResponseDto) },
        {
          properties: {
            data: {
              type: 'array',
              items: { $ref: getSchemaPath(ProductResponseDto) },
            },
          },
        },
      ],
    },
  })
  async getProducts(@Query() queryDto: GetProductsDto) {
    const query = new GetProductsQuery(
      queryDto.limit,
      queryDto.cursor,
      queryDto.categoryId,
      queryDto.search,
      queryDto.status,
      queryDto.minPrice,
      queryDto.maxPrice,
    );

    const result = await this.queryBus.execute<
      GetProductsQuery,
      PaginatedResult<Product>
    >(query);

    return PaginatedResponseDto.map(result, ProductMapper.toResponse);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get product by ID' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({ status: 200, description: 'Product retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async getProductById(@Param('id') id: string) {
    const query = new GetProductByIdQuery(id);
    const product = await this.queryBus.execute<GetProductByIdQuery, Product>(
      query,
    );
    return ProductMapper.toResponse(product);
  }

  @Patch(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a product' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({ status: 200, description: 'Product published successfully' })
  @ApiResponse({
    status: 400,
    description: 'Cannot publish product without SKUs or Price',
  })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async publishProduct(@Param('id') id: string) {
    const command = new PublishProductCommand(id);
    const product = await this.commandBus.execute<
      PublishProductCommand,
      Product
    >(command);
    return ProductMapper.toResponse(product);
  }

  @Patch(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unpublish a product' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({ status: 200, description: 'Product unpublished successfully' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async unpublishProduct(@Param('id') id: string) {
    const command = new UnpublishProductCommand(id);
    const product = await this.commandBus.execute<
      UnpublishProductCommand,
      Product
    >(command);
    return ProductMapper.toResponse(product);
  }

  // ================= SKUS =================

  @Post(':id/skus')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a SKU to a product' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiResponse({ status: 201, description: 'SKU added successfully' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async addSku(@Param('id') id: string, @Body() dto: AddSkuDto) {
    const command = new AddSkuCommand(
      id,
      dto.skuCode,
      dto.price,
      dto.attributes,
      dto.barcode,
    );
    const sku = await this.commandBus.execute<AddSkuCommand, Sku>(command);
    return {
      id: sku.id,
      skuCode: sku.skuCode,
      price: sku.price,
      attributes: sku.attributes,
      barcode: sku.barcode,
    };
  }

  @Delete(':id/skus/:skuId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a SKU from a product' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiParam({ name: 'skuId', description: 'SKU ID' })
  @ApiResponse({ status: 204, description: 'SKU removed successfully' })
  @ApiResponse({ status: 404, description: 'Product or SKU not found' })
  async removeSku(@Param('id') id: string, @Param('skuId') skuId: string) {
    const command = new RemoveSkuCommand(id, skuId);
    await this.commandBus.execute(command);
  }

  @Patch(':id/skus/:skuId/price')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update price of a SKU' })
  @ApiParam({ name: 'id', description: 'Product ID' })
  @ApiParam({ name: 'skuId', description: 'SKU ID' })
  @ApiResponse({ status: 200, description: 'SKU price updated successfully' })
  @ApiResponse({ status: 404, description: 'Product or SKU not found' })
  async updateSkuPrice(
    @Param('id') id: string,
    @Param('skuId') skuId: string,
    @Body() dto: UpdateSkuPriceDto,
  ) {
    const command = new UpdateSkuPriceCommand(id, skuId, dto.price);
    const product = await this.commandBus.execute<
      UpdateSkuPriceCommand,
      Product
    >(command);
    return ProductMapper.toResponse(product);
  }
}
