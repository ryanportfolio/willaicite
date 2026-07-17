import { politeFetch, delay, GPTBOT_UA, type Fetcher, type FetchResult } from './fetcher.js';
import { parseRobots, isAllowed } from './robots.js';
import { parseSitemap, pickExtraPages } from './sitemap.js';
import { extractLinks } from './html.js';
import type { AuditContext, PageData, SitemapEntry } from './context.js';
import type { AuditResult, DimensionResult } from './types.js';
import { checkCrawlerAccess } from './checks/crawlerAccess.js';
import { checkRenderability } from './checks/renderability.js';
import { checkStructuredData } from './checks/structuredData.js';
import { checkAnswerReadiness } from './checks/answerReadiness.js';
import { checkTopicalFocus } from './checks/topicalFocus.js';
import { checkEvidenceDensity } from './checks/evidenceDensity.js';
import { checkFreshness } from './checks/freshness.js';
import { checkEntityEeat } from './checks/entityEeat.js';
import { checkLlmsTxt } from './checks/llmsTxt.js';
import { overallScore, verdictFor, prioritize } from './score.js';

export const VERSION = '1.3.0';
const MAX_PAGES = 10;
const OWN_BOT_TOKEN = 'geo-audit';

export interface AuditOptions {
  fetcher?: Fetcher;
  /** Politeness delay between requests, ms. */
  delayMs?: number;
  now?: Date;
  /** Real progress callback (one call per network request + per phase). */
  onProgress?: (message: string) => void;
}

export async function runAudit(inputUrl: string, opts: AuditOptions = {}): Promise<AuditResult> {
  const fetcher = opts.fetcher ?? politeFetch;
  const delayMs = opts.delayMs ?? 150;
  const now = opts.now ?? new Date();

  const target = new URL(normalizeUrl(inputUrl));
  const origin = target.origin;
  let pagesFetched = 0;
  const pagesAudited: string[] = [];

  const politeGet = async (url: string, ua?: string, discardBody = false): Promise<FetchResult> => {
    if (pagesFetched > 0 && delayMs > 0) await delay(delayMs);
    pagesFetched++;
    opts.onProgress?.(`fetching ${url}${ua === GPTBOT_UA ? ' (as GPTBot)' : ''}`);
    return fetcher(url, ua ? { ua, discardBody } : { discardBody });
  };

  // 1. robots.txt
  const robotsUrl = origin + '/robots.txt';
  const robotsFetch = await politeGet(robotsUrl);
  const robotsParsed = robotsFetch.status === 200 && robotsFetch.body ? parseRobots(robotsFetch.body) : null;

  const allowedForSelf = (url: string): boolean => {
    if (!robotsParsed) return true;
    try {
      const u = new URL(url);
      return isAllowed(robotsParsed, OWN_BOT_TOKEN, u.pathname + u.search).allowed;
    } catch {
      return true;
    }
  };

  /** Auxiliary fetches (sitemap, llms.txt, favicon) also honor robots.txt for our own token. */
  const politeGetIfAllowed = async (url: string, ua?: string, discardBody = false): Promise<FetchResult> => {
    if (!allowedForSelf(url)) {
      return { ok: false, status: null, headers: {}, body: null, finalUrl: null, error: `skipped: robots.txt disallows ${OWN_BOT_TOKEN} for this path` };
    }
    return politeGet(url, ua, discardBody);
  };

  const fetchPage = async (url: string): Promise<PageData | null> => {
    if (pagesFetched >= MAX_PAGES) return null;
    if (!allowedForSelf(url)) return null;
    const res = await politeGet(url);
    if (res.status !== null) pagesAudited.push(url);
    const isHtml = res.body !== null && /text\/html|application\/xhtml/i.test(res.headers['content-type'] ?? 'text/html');
    return { url, fetch: res, html: res.ok && isHtml ? res.body : null };
  };

  // 2. Target page (tool UA), then same URL with GPTBot UA for the WAF differential
  let targetPage: PageData | null = null;
  let targetSkippedReason: string | null = null;
  if (allowedForSelf(target.href)) {
    targetPage = await fetchPage(target.href);
  } else {
    targetSkippedReason = `robots.txt disallows ${OWN_BOT_TOKEN} (via the matching group) for this path; geo-audit respects robots.txt for its own fetching`;
  }

  let targetBotFetch: FetchResult | null = null;
  if (targetPage && allowedForSelf(target.href)) {
    targetBotFetch = await politeGet(target.href, GPTBOT_UA, true);
  }

  // 3. Homepage (when distinct)
  let homepage: PageData | null = null;
  const homeUrl = origin + '/';
  if (normalizePath(target.href) !== normalizePath(homeUrl)) {
    homepage = await fetchPage(homeUrl);
  }

  // 4. About page: prefer an about link found on the page, then /about, /about-us
  const aboutCandidates: string[] = [];
  for (const page of [targetPage, homepage]) {
    if (!page?.html) continue;
    const aboutLink = extractLinks(page.html).find(
      (l) => /(^|\/)about([/-]|\.|$)/i.test(l.href) && (!/^https?:\/\//i.test(l.href) || sameHost(l.href, page.url)),
    );
    if (aboutLink) {
      try {
        aboutCandidates.push(new URL(aboutLink.href, page.url).href);
        break;
      } catch {
        /* ignore bad href */
      }
    }
  }
  aboutCandidates.push(origin + '/about', origin + '/about-us');
  let aboutPage: PageData | null = null;
  for (const candidate of dedupe(aboutCandidates).slice(0, 2)) {
    const page = await fetchPage(candidate);
    if (page === null) continue;
    aboutPage = page;
    if (page.fetch.status === 200) break;
  }

  // 5. Sitemap. A robots-declared sitemap on a different host is ignored in
  // favor of the same-origin default (a hostile robots.txt must not be able to
  // point this tool at arbitrary third-party URLs).
  const declaredSitemap = robotsParsed?.sitemaps[0];
  const sitemapUrl = declaredSitemap && sameHost(declaredSitemap, origin) ? declaredSitemap : origin + '/sitemap.xml';
  let sitemap: AuditContext['sitemap'] = null;
  const sitemapFetch = await politeGetIfAllowed(sitemapUrl);
  let entries: SitemapEntry[] = [];
  if (sitemapFetch.status === 200 && sitemapFetch.body) {
    const parsed = parseSitemap(sitemapFetch.body);
    entries = parsed.entries;
    const childUrl = parsed.childSitemaps[0];
    if (entries.length === 0 && childUrl && sameHost(childUrl, origin) && pagesFetched < MAX_PAGES) {
      const child = await politeGetIfAllowed(childUrl);
      if (child.status === 200 && child.body) entries = parseSitemap(child.body).entries;
    }
  }
  sitemap = { url: sitemapUrl, fetch: sitemapFetch, entries };

  // 6. A few extra pages from the sitemap (stay under the total page budget)
  const alreadyFetched = new Set([target.href, homeUrl, ...(aboutPage ? [aboutPage.url] : [])]);
  const extraPages: PageData[] = [];
  const budget = Math.min(3, Math.max(0, MAX_PAGES - pagesFetched - 2)); // reserve llms.txt + favicon
  for (const entry of pickExtraPages(entries, alreadyFetched, budget)) {
    if (!sameHost(entry.loc, origin)) continue;
    const page = await fetchPage(entry.loc);
    if (page) extraPages.push(page);
  }

  // 7. llms.txt + favicon (small, not counted toward the HTML page budget)
  const llmsUrl = origin + '/llms.txt';
  const llmsFetch = await politeGetIfAllowed(llmsUrl);
  const faviconFetch = await politeGetIfAllowed(origin + '/favicon.ico', undefined, true);

  const ctx: AuditContext = {
    targetUrl: target.href,
    origin,
    fetchedAt: now.toISOString(),
    robots: { url: robotsUrl, fetch: robotsFetch, parsed: robotsParsed },
    target: targetPage,
    targetSkippedReason,
    targetBotFetch,
    homepage,
    aboutPage,
    sitemap,
    extraPages,
    llmsTxt: { url: llmsUrl, fetch: llmsFetch },
    faviconStatus: faviconFetch.status,
  };

  opts.onProgress?.('running checks');
  return buildResult(inputUrl, ctx, now);
}

/** Pure assembly from a context — separated so tests can drive it without network. */
export function buildResult(inputUrl: string, ctx: AuditContext, now: Date = new Date()): AuditResult {
  const checks: [string, () => DimensionResult][] = [
    ['crawlerAccess', () => checkCrawlerAccess(ctx)],
    ['renderability', () => checkRenderability(ctx)],
    ['structuredData', () => checkStructuredData(ctx)],
    ['answerReadiness', () => checkAnswerReadiness(ctx)],
    ['topicalFocus', () => checkTopicalFocus(ctx)],
    ['evidenceDensity', () => checkEvidenceDensity(ctx)],
    ['freshness', () => checkFreshness(ctx, now)],
    ['entityEeat', () => checkEntityEeat(ctx)],
  ];

  const dimensions: DimensionResult[] = checks.map(([key, run]) => {
    try {
      return run();
    } catch (err) {
      return {
        key,
        name: key,
        weight: 0,
        score: null,
        evidence: [{ status: 'unverified' as const, message: `could not verify; check crashed: ${err instanceof Error ? err.message : String(err)}` }],
        recommendations: [],
      };
    }
  });

  let informational: DimensionResult[];
  try {
    informational = [checkLlmsTxt(ctx)];
  } catch (err) {
    informational = [
      {
        key: 'llmsTxt',
        name: 'llms.txt (informational)',
        weight: 0,
        score: null,
        evidence: [{ status: 'unverified' as const, message: `could not verify; check crashed: ${err instanceof Error ? err.message : String(err)}` }],
        recommendations: [],
      },
    ];
  }

  const overall = overallScore(dimensions);
  const pages = [ctx.target, ctx.homepage, ctx.aboutPage, ...ctx.extraPages]
    .filter((p): p is PageData => p !== null && p.fetch.status === 200)
    .map((p) => p.url);

  return {
    tool: 'geo-audit',
    version: VERSION,
    url: inputUrl,
    finalUrl: ctx.target?.fetch.finalUrl ?? null,
    fetchedAt: ctx.fetchedAt,
    overallScore: overall,
    verdict: verdictFor(overall),
    dimensions,
    informational,
    pagesAudited: dedupe(pages),
    limitations: [
      'No JS execution: renderability is judged heuristically from raw HTML; lazy-loaded content may be undercounted.',
      'Answer-readiness uses lexical heuristics (short subject + is/are/means/helps + predicate patterns), not semantic understanding.',
      'No live AI-engine querying: this audit measures retrieval/citation readiness, not actual share of voice.',
      'Checks that could not run are reported as "could not verify" and excluded from the weighted score.',
    ],
  };
}

export { prioritize };

function normalizeUrl(input: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  return new URL(withScheme).href;
}

function normalizePath(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.replace(/\/$/, '') || '/');
  } catch {
    return url;
  }
}

/** Same scheme, port, and www-tolerant hostname — a robots-declared sitemap on
 * an odd port or scheme of the same host is treated as foreign. */
function sameHost(url: string, origin: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(origin);
    return (
      a.protocol === b.protocol &&
      a.port === b.port &&
      a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '')
    );
  } catch {
    return false;
  }
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
