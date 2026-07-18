/**
 * Offline scorer: runs the real geo-audit checks against a locally built
 * Academy dist/ directory, one buildResult per page, so the rubric can be
 * iterated without deploys. Network-only dims (crawlerAccess UA differential)
 * are synthesized as clean; those are re-verified live at the end.
 *
 * Usage: npx tsx scripts/score-dist.ts <distDir> [pathFilter]
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildResult } from '../src/audit.js';
import { parseRobots } from '../src/robots.js';
import { parseSitemap } from '../src/sitemap.js';
import type { AuditContext, PageData } from '../src/context.js';
import type { FetchResult } from '../src/fetcher.js';

const ORIGIN = process.env.SCORE_ORIGIN ?? 'https://corewise.academy';
const dist = process.argv[2];
const filter = process.argv[3] ?? '';
if (!dist) {
  console.error('usage: tsx score-dist.ts <distDir> [pathFilter]');
  process.exit(2);
}

function res(body: string | null, status = 200, headers: Record<string, string> = {}): FetchResult {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body,
    finalUrl: null,
    error: null,
  };
}

function pageFor(urlPath: string): PageData | null {
  const rel = urlPath.replace(/^\//, '').replace(/\/$/, '');
  const file = rel === '' ? join(dist, 'index.html') : join(dist, rel, 'index.html');
  if (!existsSync(file)) return null;
  const html = readFileSync(file, 'utf8');
  const url = ORIGIN + urlPath;
  return { url, fetch: { ...res(html), finalUrl: url }, html };
}

function collectPages(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectPages(full, prefix + '/' + name));
    } else if (name === 'index.html') {
      out.push(prefix === '' ? '/' : prefix + '/');
    }
  }
  return out;
}

const robotsBody = existsSync(join(dist, 'robots.txt')) ? readFileSync(join(dist, 'robots.txt'), 'utf8') : null;
const sitemapBody = existsSync(join(dist, 'sitemap.xml')) ? readFileSync(join(dist, 'sitemap.xml'), 'utf8') : null;
const llmsBody = existsSync(join(dist, 'llms.txt')) ? readFileSync(join(dist, 'llms.txt'), 'utf8') : null;

const homepage = pageFor('/');
const aboutPage = pageFor('/about/');
const now = new Date();

const urls = collectPages(dist).filter((u) => u.includes(filter));
let failures = 0;
for (const urlPath of urls.sort()) {
  const target = pageFor(urlPath)!;
  const ctx: AuditContext = {
    targetUrl: ORIGIN + urlPath,
    origin: ORIGIN,
    fetchedAt: now.toISOString(),
    robots: {
      url: ORIGIN + '/robots.txt',
      fetch: robotsBody ? { ...res(robotsBody), headers: { 'content-type': 'text/plain' } } : res(null, 404),
      parsed: robotsBody ? parseRobots(robotsBody) : null,
    },
    target,
    targetSkippedReason: null,
    targetBotFetch: res(null, 200),
    homepage: urlPath === '/' ? null : homepage,
    aboutPage,
    sitemap: sitemapBody
      ? { url: ORIGIN + '/sitemap.xml', fetch: { ...res(sitemapBody), headers: { 'content-type': 'application/xml' } }, entries: parseSitemap(sitemapBody).entries }
      : null,
    extraPages: [],
    llmsTxt: { url: ORIGIN + '/llms.txt', fetch: llmsBody ? { ...res(llmsBody), headers: { 'content-type': 'text/plain' } } : res(null, 404) },
    faviconStatus: 200,
  };
  const result = buildResult(ctx.targetUrl, ctx, now);
  const bad = result.dimensions.filter((d) => d.score !== null && d.score < 100);
  const mark = result.overallScore === 100 ? 'OK ' : 'BAD';
  if (result.overallScore !== 100) failures++;
  console.log(`${mark} ${result.overallScore}  ${urlPath}`);
  for (const d of bad) {
    console.log(`      ${d.key}=${d.score}`);
    for (const e of d.evidence.filter((e) => e.status === 'fail' || e.status === 'warn')) {
      console.log(`        [${e.status}] ${e.message.slice(0, 160)}`);
    }
  }
}
console.log(failures === 0 ? 'ALL PAGES 100' : `${failures} page(s) below 100`);
process.exit(failures === 0 ? 0 : 1);
