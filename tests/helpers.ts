import { readFileSync } from 'node:fs';
import type { FetchResult } from '../src/fetcher.js';
import type { AuditContext, PageData } from '../src/context.js';
import { parseRobots } from '../src/robots.js';

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

export function makeFetch(over: Partial<FetchResult> = {}): FetchResult {
  return { ok: true, status: 200, headers: {}, body: null, finalUrl: null, error: null, ...over };
}

export function makePage(url: string, html: string | null, over: Partial<FetchResult> = {}): PageData {
  return {
    url,
    fetch: makeFetch({ body: html, finalUrl: url, ...over }),
    html,
  };
}

export function makeCtx(over: Partial<AuditContext> = {}): AuditContext {
  return {
    targetUrl: 'https://example.com/guide',
    origin: 'https://example.com',
    fetchedAt: '2026-07-01T00:00:00.000Z',
    robots: {
      url: 'https://example.com/robots.txt',
      fetch: makeFetch({ ok: false, status: 404, body: null }),
      parsed: null,
    },
    target: makePage('https://example.com/guide', fixture('article-good.html')),
    targetSkippedReason: null,
    targetBotFetch: makeFetch({ body: null }),
    homepage: null,
    aboutPage: makePage('https://example.com/about', '<html><body><h1>About us</h1></body></html>'),
    sitemap: null,
    extraPages: [],
    llmsTxt: { url: 'https://example.com/llms.txt', fetch: makeFetch({ ok: false, status: 404, body: null }) },
    faviconStatus: 200,
    ...over,
  };
}

export function robotsCtxFrom(fixtureName: string): AuditContext['robots'] {
  const body = fixture(fixtureName);
  return {
    url: 'https://example.com/robots.txt',
    fetch: makeFetch({ body }),
    parsed: parseRobots(body),
  };
}

/** Fixed "now" for deterministic freshness tests. */
export const NOW = new Date('2026-07-01T00:00:00.000Z');
