import type { AuditContext } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { extractJsonLd, extractVisibleText, findMeta } from '../html.js';
import { parseDateUTC } from '../dates.js';

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
const VISIBLE_DATE_RE = new RegExp(
  `\\b(?:\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS})\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:${MONTHS})\\.?\\s+\\d{4})\\b`,
  'gi',
);

interface DatedSignal {
  source: string;
  raw: string;
  date: Date;
  /** Header-only signals are weak (often just server/deploy time). */
  weak: boolean;
}

/**
 * Freshness (weight: high, was medium in v1.2). Two independent 2025-2026
 * studies moved this up: the 252,000-trial controlled study (Vishwakarma et
 * al., SIGIR 2026) found a recent timestamp is one of the few content factors
 * that consistently lifts citation odds across all six LLMs tested, and the
 * GEO-16 field audit (Kumar & Palkhouski 2025) found metadata/freshness the
 * pillar most strongly associated with real citations on Brave, Google AI
 * Overviews and Perplexity. Visible, machine-readable dates matter twice:
 * once for the recency preference, once so the engine can date the content
 * at all.
 */
export function checkFreshness(ctx: AuditContext, now: Date = new Date()): DimensionResult {
  const dim = 'Freshness';
  const evidence: Evidence[] = [];
  const recommendations: Recommendation[] = [];
  const signals: DatedSignal[] = [];
  const html = ctx.target?.html ?? null;

  if (html !== null) {
    // JSON-LD dates
    const { nodes } = extractJsonLd(html);
    for (const node of nodes) {
      for (const key of ['dateModified', 'datePublished'] as const) {
        const v = node[key];
        if (typeof v === 'string') {
          const d = parseDate(v);
          if (d) signals.push({ source: `JSON-LD ${key}`, raw: v, date: d, weak: false });
        }
      }
    }
    // article meta
    for (const key of ['article:modified_time', 'article:published_time', 'og:updated_time']) {
      const v = findMeta(html, key);
      if (v) {
        const d = parseDate(v);
        if (d) signals.push({ source: `meta ${key}`, raw: v, date: d, weak: false });
      }
    }
    // <time datetime="...">
    const timeRe = /<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/gi;
    let tm: RegExpExecArray | null;
    while ((tm = timeRe.exec(html)) !== null) {
      const d = parseDate(tm[1]);
      if (d) signals.push({ source: '<time datetime>', raw: tm[1], date: d, weak: false });
    }
    // visible date strings near start/end of content
    const text = extractVisibleText(html);
    const zone = text.slice(0, 1500) + ' ' + text.slice(-1500);
    for (const m of zone.match(VISIBLE_DATE_RE) ?? []) {
      const d = parseDate(m);
      if (d) signals.push({ source: 'visible date text', raw: m, date: d, weak: false });
    }
  } else {
    evidence.push({ status: 'unverified', message: 'could not verify on-page dates: page HTML unavailable' });
  }

  // sitemap lastmod for the audited URL
  if (ctx.sitemap) {
    const entry = ctx.sitemap.entries.find((e) => sameUrl(e.loc, ctx.targetUrl));
    if (entry?.lastmod) {
      const d = parseDate(entry.lastmod);
      if (d) signals.push({ source: 'sitemap <lastmod>', raw: entry.lastmod, date: d, weak: false });
    }
  }

  // Last-Modified header (weak: often server/deploy time, not content time)
  const lastModified = ctx.target?.fetch.headers['last-modified'];
  if (lastModified) {
    const d = parseDate(lastModified);
    if (d) signals.push({ source: 'Last-Modified header', raw: lastModified, date: d, weak: true });
  }

  const valid = signals.filter((s) => s.date.getTime() <= now.getTime() + 86_400_000);
  const strong = valid.filter((s) => !s.weak);

  if (valid.length === 0) {
    if (html === null && !lastModified && !ctx.sitemap) {
      return { key: 'freshness', name: dim, weight: 3, score: null, evidence, recommendations };
    }
    evidence.push({ status: 'fail', message: 'no publish/updated dates found (no visible dates, no JSON-LD dates, no sitemap lastmod, no usable Last-Modified header)' });
    recommendations.push({
      dimension: dim,
      action: 'Add a visible "Last updated" date plus dateModified in JSON-LD, and lastmod in the sitemap',
      why: 'A recent, machine-readable date is one of the few content factors that consistently lifted citation odds across all six LLMs in the 252,000-trial SIGIR 2026 study (Vishwakarma et al.); the ~3-month drop-off remains a directional heuristic, not a hard cliff. Undated content cannot demonstrate freshness at all, so it defaults to looking stale.',
      impact: 2,
      effort: 1,
    });
    return { key: 'freshness', name: dim, weight: 3, score: 30, evidence, recommendations };
  }

  const newest = valid.reduce((a, b) => (a.date.getTime() >= b.date.getTime() ? a : b));
  const ageDays = Math.floor((now.getTime() - newest.date.getTime()) / 86_400_000);
  evidence.push({
    status: 'info',
    message: `newest date signal: ${newest.raw} via ${newest.source} (${ageDays} days old); ${valid.length} date signal(s) total`,
  });
  for (const s of valid.slice(0, 6)) {
    if (s !== newest) evidence.push({ status: 'info', message: `date signal: ${s.raw} via ${s.source}` });
  }

  let score: number;
  if (ageDays <= 90) {
    score = 100;
    evidence.push({ status: 'pass', message: `content is ${ageDays} days old, inside the ~3-month window where AI engines cite most readily` });
  } else if (ageDays <= 180) {
    score = 70;
    evidence.push({ status: 'warn', message: `content is ${ageDays} days old (3-6 months), past the ~3-month recency window where citation likelihood starts dropping` });
  } else if (ageDays <= 365) {
    score = 45;
    evidence.push({ status: 'warn', message: `content is ${ageDays} days old (6-12 months); AI engines' recency bias will suppress citations` });
  } else {
    score = 20;
    evidence.push({ status: 'fail', message: `content is ${ageDays} days old (>1 year); strongly disfavored by recency-biased answer engines` });
  }

  if (strong.length === 0) {
    score = Math.min(score, 60);
    evidence.push({
      status: 'warn',
      message: 'only the Last-Modified HTTP header carries a date; that is often deploy time, not content time, and engines cannot show it to users',
    });
    recommendations.push({
      dimension: dim,
      action: 'Add a visible/structured date (on-page "Updated" line + JSON-LD dateModified), not just the Last-Modified header',
      why: 'Engines display and weigh dates they can attribute to the content itself; a bare HTTP header is invisible in the rendered page and frequently reflects deployment, not editing.',
      impact: 2,
      effort: 1,
    });
  }

  if (ageDays > 90) {
    recommendations.push({
      dimension: dim,
      action: 'Refresh the content and bump the visible + structured dateModified honestly (substantive edits, not date-only bumps)',
      why: 'Recent timestamps consistently lifted citation odds in controlled 2026 testing (Vishwakarma et al., SIGIR 2026); the ~3-month drop-off is a directional heuristic. Genuine updates restore eligibility; date-only bumps risk trust penalties when the content contradicts the claimed date.',
      impact: 2,
      effort: 2,
    });
  }

  return { key: 'freshness', name: dim, weight: 3, score, evidence, recommendations };
}

function parseDate(raw: string): Date | null {
  const d = parseDateUTC(raw);
  if (d === null) return null;
  if (d.getUTCFullYear() < 1995 || d.getUTCFullYear() > 2100) return null;
  return d;
}

function sameUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname.replace(/^www\./, '') === ub.hostname.replace(/^www\./, '') && ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '');
  } catch {
    return a === b;
  }
}
