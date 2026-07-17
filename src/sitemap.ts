import type { SitemapEntry } from './context.js';
import { parseDateUTC } from './dates.js';

/**
 * Minimal sitemap XML parsing: <url><loc>/<lastmod> entries, plus
 * <sitemapindex> child sitemap locations.
 */
export function parseSitemap(xml: string): { entries: SitemapEntry[]; childSitemaps: string[] } {
  const entries: SitemapEntry[] = [];
  const childSitemaps: string[] = [];

  if (/<sitemapindex\b/i.test(xml)) {
    const re = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const loc = tagText(m[1], 'loc');
      if (loc) childSitemaps.push(loc);
    }
    return { entries, childSitemaps };
  }

  const re = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const loc = tagText(m[1], 'loc');
    if (!loc) continue;
    entries.push({ loc, lastmod: tagText(m[1], 'lastmod') });
  }
  return { entries, childSitemaps };
}

function tagText(fragment: string, tag: string): string | null {
  const m = fragment.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
}

/**
 * Deterministic pick of extra pages to audit: newest lastmod first, then
 * alphabetical loc; entries without lastmod come last.
 */
export function pickExtraPages(entries: SitemapEntry[], exclude: Set<string>, max: number): SitemapEntry[] {
  const normalizedExclude = new Set([...exclude].map(normalize));
  const sorted = [...entries].sort((a, b) => {
    const ta = a.lastmod ? (parseDateUTC(a.lastmod)?.getTime() ?? NaN) : NaN;
    const tb = b.lastmod ? (parseDateUTC(b.lastmod)?.getTime() ?? NaN) : NaN;
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    if (va !== vb) return vb - va;
    return a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0;
  });
  const out: SitemapEntry[] = [];
  for (const e of sorted) {
    if (out.length >= max) break;
    if (normalizedExclude.has(normalize(e.loc))) continue;
    normalizedExclude.add(normalize(e.loc));
    out.push(e);
  }
  return out;
}

function normalize(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}
