import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

// Controllers
import {
  ProductController,
  CategoryController,
  AdminProductController,
  AdminCategoryController,
  CatalogSitemapController,
} from './presentation/index.js';

// Handlers
import {
  CreateProductHandler,
  GetProductsHandler,
  GetProductByIdHandler,
  GetPublishedProductByIdHandler,
  SearchProductsHandler,
  GetProductFacetsHandler,
  GetCategoryByIdHandler,
  GetCatalogSitemapHandler,
  CreateCategoryHandler,
  GetCategoriesHandler,
  DeleteCategoryHandler,
  MoveCategoryHandler,
  PublishProductHandler,
  UnpublishProductHandler,
  UpdateProductHandler,
  UpdateCategoryHandler,
  AddSkuHandler,
  RemoveSkuHandler,
  UpdateSkuPriceHandler,
  SkuLookupService,
} from './application/index.js';

// Repositories
import {
  PrismaProductRepository,
  PrismaCategoryRepository,
} from './infrastructure/index.js';

const CommandHandlers = [
  CreateProductHandler,
  CreateCategoryHandler,
  DeleteCategoryHandler,
  MoveCategoryHandler,
  PublishProductHandler,
  UnpublishProductHandler,
  UpdateProductHandler,
  UpdateCategoryHandler,
  AddSkuHandler,
  RemoveSkuHandler,
  UpdateSkuPriceHandler,
];
const QueryHandlers = [
  GetProductsHandler,
  GetProductByIdHandler,
  GetPublishedProductByIdHandler,
  SearchProductsHandler,
  GetProductFacetsHandler,
  GetCategoriesHandler,
  GetCategoryByIdHandler,
  GetCatalogSitemapHandler,
];

@Module({
  imports: [CqrsModule],
  controllers: [
    ProductController,
    CategoryController,
    AdminProductController,
    AdminCategoryController,
    CatalogSitemapController,
  ],
  providers: [
    // Repositories
    {
      provide: 'IProductRepository',
      useClass: PrismaProductRepository,
    },
    {
      provide: 'ICategoryRepository',
      useClass: PrismaCategoryRepository,
    },
    // Handlers
    ...CommandHandlers,
    ...QueryHandlers,
    SkuLookupService,
  ],
  exports: [SkuLookupService], // the cart reads many SKUs at once with it
})
export class CatalogModule {}
