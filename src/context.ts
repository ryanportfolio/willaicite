import type { FetchResult } from './fetcher.js';
import type { RobotsData } from './robots.js';

export interface PageData {
  url: string;
  fetch: FetchResult;
  html: string | null;
}

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface AuditContext {
  targetUrl: string;
  origin: string;
  fetchedAt: string;
  robots: {
    url: string;
    fetch: FetchResult | null;
    parsed: RobotsData | null;
  };
  /** The audited URL fetched with the tool UA. Null when robots.txt disallows our own crawler. */
  target: PageData | null;
  /** Why the target was not fetched, when target is null. */
  targetSkippedReason: string | null;
  /** The same URL fetched with GPTBot's UA string (WAF differential check). */
  targetBotFetch: FetchResult | null;
  /** Homepage, when distinct from the target. */
  homepage: PageData | null;
  aboutPage: PageData | null;
  sitemap: {
    url: string;
    fetch: FetchResult | null;
    entries: SitemapEntry[];
  } | null;
  /** Up to a few additional pages pulled from the sitemap. */
  extraPages: PageData[];
  llmsTxt: { url: string; fetch: FetchResult | null };
  faviconStatus: number | null;
}

/** The page whose content we score: the target, i.e. the URL the user gave us. */
export function contentPage(ctx: AuditContext): PageData | null {
  if (ctx.target?.html) return ctx.target;
  return null;
}
