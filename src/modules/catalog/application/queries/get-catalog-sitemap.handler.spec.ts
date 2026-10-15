import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GetCatalogSitemapHandler } from './get-catalog-sitemap.handler.js';

describe('GetCatalogSitemapHandler', () => {
  let handler: GetCatalogSitemapHandler;
  let productRepo: any;
  let categoryRepo: any;

  beforeEach(() => {
    productRepo = {
      findSitemapData: vi.fn(),
    };
    categoryRepo = {
      findSitemapData: vi.fn(),
    };
    handler = new GetCatalogSitemapHandler(productRepo, categoryRepo);
  });

  it('should return combined sitemap entries for categories and products', async () => {
    const now = new Date('2026-10-15T12:00:00Z');
    categoryRepo.findSitemapData.mockResolvedValueOnce([
      { slug: 'dien-thoai', updatedAt: now },
    ]);
    productRepo.findSitemapData.mockResolvedValueOnce([
      { slug: 'dien-thoai-iphone-15', updatedAt: now },
    ]);

    const result = await handler.execute();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      loc: '/categories/dien-thoai',
      lastmod: now.toISOString(),
      changefreq: 'daily',
      priority: 0.8,
    });
    expect(result[1]).toEqual({
      loc: '/products/dien-thoai-iphone-15',
      lastmod: now.toISOString(),
      changefreq: 'weekly',
      priority: 1.0,
    });
  });
});
