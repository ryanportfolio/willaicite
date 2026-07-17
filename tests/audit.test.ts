import { describe, it, expect } from 'vitest';
import { runAudit } from '../src/audit.js';
import type { Fetcher } from '../src/fetcher.js';
import { GPTBOT_UA } from '../src/fetcher.js';
import { makeFetch, fixture } from './helpers.js';

interface Recorded {
  url: string;
  ua: string | undefined;
}

/** Scripted fetcher that records every request it receives. */
function scriptedFetcher(routes: Record<string, () => ReturnType<typeof makeFetch>>, log: Recorded[]): Fetcher {
  return async (url, opts) => {
    log.push({ url, ua: opts?.ua });
    const u = new URL(url);
    const route = routes[u.pathname];
    if (route) return route();
    return makeFetch({ ok: false, status: 404, body: null, finalUrl: url });
  };
}

const htmlPage = (body: string) =>
  makeFetch({ body: `<html><body><main>${body} — enough visible words to clear every content floor in the checks.</main></body></html>`, headers: { 'content-type': 'text/html' } });

describe('runAudit orchestration', () => {
  it('never exceeds 10 total requests, even with a fat sitemap', async () => {
    const urls = Array.from({ length: 30 }, (_, i) => `<url><loc>https://example.com/p${i}</loc><lastmod>2026-06-0${(i % 9) + 1}</lastmod></url>`).join('');
    const log: Recorded[] = [];
    const fetcher = scriptedFetcher(
      {
        '/robots.txt': () => makeFetch({ body: 'User-agent: *\nDisallow:\n' }),
        '/sitemap.xml': () => makeFetch({ body: `<urlset>${urls}</urlset>`, headers: { 'content-type': 'application/xml' } }),
      },
      log,
    );
    // every other path (target, homepage, abouts, extras) serves HTML
    const withHtml: Fetcher = async (url, opts) => {
      const u = new URL(url);
      if (u.pathname === '/robots.txt' || u.pathname === '/sitemap.xml' || u.pathname === '/llms.txt' || u.pathname === '/favicon.ico') {
        return fetcher(url, opts);
      }
      log.push({ url, ua: opts?.ua });
      return htmlPage(`page ${u.pathname}`);
    };
    await runAudit('https://example.com/guide', { fetcher: withHtml, delayMs: 0 });
    expect(log.length).toBeLessThanOrEqual(10);
  });

  it('skips the target and the GPTBot differential when robots.txt disallows geo-audit', async () => {
    const log: Recorded[] = [];
    const fetcher = scriptedFetcher(
      {
        '/robots.txt': () => makeFetch({ body: 'User-agent: geo-audit\nDisallow: /\n' }),
      },
      log,
    );
    const result = await runAudit('https://example.com/guide', { fetcher, delayMs: 0 });
    // only robots.txt was fetched — everything else is gated on our own allowance
    expect(log).toHaveLength(1);
    expect(log[0].url).toContain('/robots.txt');
    const render = result.dimensions.find((d) => d.key === 'renderability');
    expect(render?.score).toBeNull();
    expect(render?.evidence[0].message).toContain('robots.txt disallows geo-audit');
  });

  it('robots-gates auxiliary fetches (llms.txt disallowed → skipped, reported unverified)', async () => {
    const log: Recorded[] = [];
    const fetcher: Fetcher = async (url, opts) => {
      log.push({ url, ua: opts?.ua });
      const u = new URL(url);
      if (u.pathname === '/robots.txt') return makeFetch({ body: 'User-agent: geo-audit\nDisallow: /llms.txt\nDisallow: /favicon.ico\n' });
      if (u.pathname === '/sitemap.xml') return makeFetch({ ok: false, status: 404, body: null });
      return htmlPage(`page ${u.pathname}`);
    };
    const result = await runAudit('https://example.com/guide', { fetcher, delayMs: 0 });
    expect(log.some((r) => r.url.endsWith('/llms.txt'))).toBe(false);
    expect(log.some((r) => r.url.endsWith('/favicon.ico'))).toBe(false);
    const llms = result.informational[0];
    expect(llms.evidence[0].status).toBe('unverified');
    expect(llms.evidence[0].message).toContain('robots.txt disallows geo-audit');
  });

  it('fetches the GPTBot differential exactly once, with the GPTBot UA, body discarded', async () => {
    const log: (Recorded & { discard: boolean | undefined })[] = [];
    const fetcher: Fetcher = async (url, opts) => {
      log.push({ url, ua: opts?.ua, discard: opts?.discardBody });
      const u = new URL(url);
      if (u.pathname === '/robots.txt' || u.pathname === '/sitemap.xml') return makeFetch({ ok: false, status: 404, body: null });
      return htmlPage(`page ${u.pathname}`);
    };
    await runAudit('https://example.com/guide', { fetcher, delayMs: 0 });
    const botFetches = log.filter((r) => r.ua === GPTBOT_UA);
    expect(botFetches).toHaveLength(1);
    expect(botFetches[0].url).toBe('https://example.com/guide');
    expect(botFetches[0].discard).toBe(true);
  });

  it('ignores a robots-declared sitemap on a foreign host', async () => {
    const log: Recorded[] = [];
    const fetcher: Fetcher = async (url, opts) => {
      log.push({ url, ua: opts?.ua });
      const u = new URL(url);
      if (u.pathname === '/robots.txt') return makeFetch({ body: 'User-agent: *\nDisallow:\nSitemap: https://evil.example.net/sitemap.xml\n' });
      if (u.pathname === '/sitemap.xml') return makeFetch({ ok: false, status: 404, body: null });
      return htmlPage(`page ${u.pathname}`);
    };
    await runAudit('https://example.com/guide', { fetcher, delayMs: 0 });
    expect(log.some((r) => r.url.includes('evil.example.net'))).toBe(false);
    expect(log.some((r) => r.url === 'https://example.com/sitemap.xml')).toBe(true);
  });

  it('ignores a robots-declared sitemap on the same host but a different port', async () => {
    const log: Recorded[] = [];
    const fetcher: Fetcher = async (url, opts) => {
      log.push({ url, ua: opts?.ua });
      const u = new URL(url);
      if (u.pathname === '/robots.txt') return makeFetch({ body: 'User-agent: *\nDisallow:\nSitemap: https://example.com:8443/sitemap.xml\n' });
      if (u.pathname === '/sitemap.xml') return makeFetch({ ok: false, status: 404, body: null });
      return htmlPage(`page ${u.pathname}`);
    };
    await runAudit('https://example.com/guide', { fetcher, delayMs: 0 });
    expect(log.some((r) => r.url.includes(':8443'))).toBe(false);
    expect(log.some((r) => r.url === 'https://example.com/sitemap.xml')).toBe(true);
  });

  it('discovers the about page from an on-page link before falling back to /about', async () => {
    const log: Recorded[] = [];
    const fetcher: Fetcher = async (url, opts) => {
      log.push({ url, ua: opts?.ua });
      const u = new URL(url);
      if (u.pathname === '/robots.txt' || u.pathname === '/sitemap.xml') return makeFetch({ ok: false, status: 404, body: null });
      if (u.pathname === '/guide') {
        return makeFetch({
          body: '<html><body><main><p>Guide content long enough to be a real page for the audit checks here.</p><a href="/about-the-team">About the team</a></main></body></html>',
          headers: { 'content-type': 'text/html' },
        });
      }
      return htmlPage(`page ${u.pathname}`);
    };
    const result = await runAudit('https://example.com/guide', { fetcher, delayMs: 0 });
    expect(log.some((r) => r.url === 'https://example.com/about-the-team')).toBe(true);
    expect(result.pagesAudited).toContain('https://example.com/about-the-team');
  });
});
