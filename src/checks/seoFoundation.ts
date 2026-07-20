import type { AuditContext, PageData } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { extractCanonical, extractTitle, findMeta } from '../html.js';

/**
 * SEO foundation: the small subset of classic SEO hygiene that also decides
 * which URL an AI engine attributes and cites. Deliberately narrow — presence
 * of title/description/canonical is already scored in topical focus; this
 * dimension checks the cross-cutting failure modes those single-page checks
 * cannot see: a canonical that points AWAY from the audited URL (the citation
 * lands on a different address), and titles/descriptions duplicated across
 * pages (retrieval cannot tell the pages apart). Low weight: these are
 * hygiene multipliers, not primary citation drivers in the 2025-2026
 * literature.
 */

/** Comparable URL identity: scheme-insensitive, www-insensitive, trailing-slash-insensitive. */
function urlKey(url: string, base?: string): string | null {
  try {
    const u = base ? new URL(url, base) : new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.replace(/\/+$/, '') || '/') + u.search;
  } catch {
    return null;
  }
}

export function checkSeoFoundation(ctx: AuditContext): DimensionResult {
  const dim = 'SEO foundation';
  const pages: PageData[] = [ctx.target, ctx.homepage, ctx.aboutPage, ...ctx.extraPages].filter(
    (p): p is PageData => Boolean(p?.html),
  );

  if (pages.length === 0) {
    return {
      key: 'seoFoundation',
      name: dim,
      weight: 1,
      score: null,
      evidence: [{ status: 'unverified', message: 'could not verify: no page HTML available' }],
      recommendations: [],
    };
  }

  const evidence: Evidence[] = [];
  const recommendations: Recommendation[] = [];
  // Each assessable part contributes 0-100; the score renormalizes over the
  // parts that could actually be checked (matches the overall-score policy).
  const parts: number[] = [];

  // 1. Canonical self-consistency on the audited page. Presence alone is
  // scored in topical focus; here the href must resolve back to the page
  // itself, else every consumer that honors canonicals attributes the content
  // to a different URL than the one audited.
  if (ctx.target?.html) {
    const pageUrl = ctx.target.fetch.finalUrl ?? ctx.target.url;
    const canonical = extractCanonical(ctx.target.html);
    if (canonical === null) {
      parts.push(30);
      evidence.push({ status: 'warn', message: 'no canonical link on the audited page; parameter/www/slash variants can split its retrieval identity' });
      recommendations.push({
        dimension: dim,
        action: 'Add a self-referencing <link rel="canonical"> to the audited page',
        why: 'Engines and crawl pipelines consolidate duplicate URL variants onto the canonical; without one, citations and link equity can scatter across variants of the same page.',
        impact: 1,
        effort: 1,
      });
    } else {
      const canonKey = urlKey(canonical, pageUrl);
      const pageKey = urlKey(pageUrl);
      if (canonKey !== null && pageKey !== null && canonKey === pageKey) {
        parts.push(100);
        evidence.push({ status: 'pass', message: `canonical is self-referencing (${canonical})` });
      } else {
        parts.push(0);
        evidence.push({
          status: 'fail',
          message: `canonical points away from the audited page: canonical "${canonical}" vs page "${pageUrl}"`,
        });
        recommendations.push({
          dimension: dim,
          action: 'Fix the canonical URL so it references the page it is on (or audit the canonical target instead)',
          why: 'A canonical pointing elsewhere tells every consumer that honors it — including AI crawl pipelines — that this page is a duplicate: the cited/indexed URL becomes the canonical target, not this page.',
          impact: 2,
          effort: 1,
        });
      }
    }
  } else {
    evidence.push({ status: 'unverified', message: 'canonical consistency not assessable: audited page HTML unavailable' });
  }

  // 2 & 3. Title / meta-description uniqueness across the audited pages.
  // Duplicated metadata makes distinct pages indistinguishable to a retriever
  // matching a query against titles and snippets.
  const assessUniqueness = (
    label: 'title' | 'meta description',
    valueOf: (html: string) => string | null,
    action: string,
    why: string,
  ) => {
    const withValue = pages
      .map((p) => ({ url: p.url, value: valueOf(p.html!)?.trim().toLowerCase() ?? null }))
      .filter((p): p is { url: string; value: string } => Boolean(p.value));
    if (withValue.length < 2) {
      evidence.push({ status: 'info', message: `${label} uniqueness not assessable (fewer than 2 audited pages carry a ${label})` });
      return;
    }
    const byValue = new Map<string, string[]>();
    for (const p of withValue) byValue.set(p.value, [...(byValue.get(p.value) ?? []), p.url]);
    const dupes = [...byValue.values()].filter((urls) => urls.length > 1);
    if (dupes.length === 0) {
      parts.push(100);
      evidence.push({ status: 'pass', message: `${label}s are unique across the ${withValue.length} audited pages that have one` });
    } else {
      parts.push(0);
      const example = dupes[0];
      evidence.push({
        status: 'fail',
        message: `duplicated ${label} across pages (e.g. ${example.slice(0, 3).join(' and ')})`,
      });
      recommendations.push({ dimension: dim, action, why, impact: 2, effort: 1 });
    }
  };

  assessUniqueness(
    'title',
    extractTitle,
    'Give every page a unique <title> naming that page\'s specific topic',
    'The title is the primary surface a retriever matches a query against; pages sharing one title compete as duplicates instead of each winning its own queries.',
  );
  assessUniqueness(
    'meta description',
    (html) => findMeta(html, 'description'),
    'Write a distinct meta description per page',
    'Engines use the description as a snippet/retrieval signal; identical descriptions across pages erase the differences a retriever could use to pick the right page.',
  );

  evidence.push({
    status: 'info',
    message: `scope note: only the ${pages.length} fetched page(s) were compared; presence/length of title, description and canonical are scored under topical focus & metadata`,
  });

  const score = parts.length > 0 ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
  return {
    key: 'seoFoundation',
    name: dim,
    weight: 1,
    score,
    evidence,
    recommendations,
  };
}
