import { describe, it, expect } from 'vitest';
import { parseSitemap, pickExtraPages } from '../src/sitemap.js';
import { fixture } from './helpers.js';

describe('parseSitemap', () => {
  it('parses urlset entries with lastmod', () => {
    const { entries, childSitemaps } = parseSitemap(fixture('sitemap.xml'));
    expect(childSitemaps).toHaveLength(0);
    expect(entries).toHaveLength(5);
    expect(entries[1]).toEqual({ loc: 'https://example.com/guide', lastmod: '2026-06-20' });
    expect(entries[4].lastmod).toBeNull();
  });

  it('parses a sitemapindex into child sitemaps', () => {
    const { entries, childSitemaps } = parseSitemap(fixture('sitemap-index.xml'));
    expect(entries).toHaveLength(0);
    expect(childSitemaps).toEqual(['https://example.com/sitemap-posts.xml', 'https://example.com/sitemap-pages.xml']);
  });

  it('returns nothing for non-XML input', () => {
    const { entries, childSitemaps } = parseSitemap('<html><body>404</body></html>');
    expect(entries).toHaveLength(0);
    expect(childSitemaps).toHaveLength(0);
  });
});

describe('pickExtraPages', () => {
  const { entries } = parseSitemap(fixture('sitemap.xml'));

  it('picks newest-first, deterministically, excluding already-fetched URLs', () => {
    const picked = pickExtraPages(entries, new Set(['https://example.com/guide', 'https://example.com/']), 3);
    expect(picked.map((e) => e.loc)).toEqual([
      'https://example.com/blog/newest',
      'https://example.com/blog/older',
      'https://example.com/undated',
    ]);
  });

  it('respects the max budget', () => {
    expect(pickExtraPages(entries, new Set(), 2)).toHaveLength(2);
  });

  it('treats trailing-slash and www variants as the same URL', () => {
    const picked = pickExtraPages(entries, new Set(['https://www.example.com/blog/newest/']), 5);
    expect(picked.map((e) => e.loc)).not.toContain('https://example.com/blog/newest');
  });
});
