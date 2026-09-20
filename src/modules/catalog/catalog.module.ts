import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@/core/index.js';

// Controllers
import { CatalogController } from './presentation/index.js';

// Handlers
import {
  CreateProductHandler,
  GetProductsHandler,
  GetProductByIdHandler,
  CreateCategoryHandler,
  GetCategoriesHandler,
  DeleteCategoryHandler,
  MoveCategoryHandler,
  PublishProductHandler,
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
];
const QueryHandlers = [
  GetProductsHandler,
  GetProductByIdHandler,
  GetCategoriesHandler,
];

@Module({
  imports: [CqrsModule],
  controllers: [CatalogController],
  providers: [
    PrismaService,
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
  ],
})
export class CatalogModule {}
