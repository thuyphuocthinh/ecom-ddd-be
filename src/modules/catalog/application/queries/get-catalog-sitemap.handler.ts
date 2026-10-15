import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import type {
  IProductRepository,
  ICategoryRepository,
} from '../../domain/index.js';
import { GetCatalogSitemapQuery } from './get-catalog-sitemap.query.js';

export interface SitemapEntry {
  loc: string;
  lastmod: string;
  changefreq:
    'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority: number;
}

@QueryHandler(GetCatalogSitemapQuery)
export class GetCatalogSitemapHandler implements IQueryHandler<
  GetCatalogSitemapQuery,
  SitemapEntry[]
> {
  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
    @Inject('ICategoryRepository')
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async execute(): Promise<SitemapEntry[]> {
    const [categories, products] = await Promise.all([
      this.categoryRepo.findSitemapData(),
      this.productRepo.findSitemapData(),
    ]);

    const categoryEntries: SitemapEntry[] = categories.map((c) => ({
      loc: `/categories/${c.slug}`,
      lastmod:
        c.updatedAt instanceof Date
          ? c.updatedAt.toISOString()
          : new Date(c.updatedAt).toISOString(),
      changefreq: 'daily',
      priority: 0.8,
    }));

    const productEntries: SitemapEntry[] = products.map((p) => ({
      loc: `/products/${p.slug}`,
      lastmod:
        p.updatedAt instanceof Date
          ? p.updatedAt.toISOString()
          : new Date(p.updatedAt).toISOString(),
      changefreq: 'weekly',
      priority: 1.0,
    }));

    return [...categoryEntries, ...productEntries];
  }
}
