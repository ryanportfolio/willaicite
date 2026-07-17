import type { AuditContext } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { extractLinks, extractVisibleText, mainContentHtml, wordCount, countTag } from '../html.js';

/**
 * Evidence density, grounded in the original GEO research (Aggarwal et al.
 * 2023, "GEO: Generative Engine Optimization", KDD 2024): adding quotations
 * lifted generative-engine visibility +27.8%, statistics +25.9%, and citing
 * sources +24.9% relative to baseline. Those numbers are cited in the
 * recommendations so they carry their evidence.
 */

// `%` sits outside the trailing \b group: a word boundary after `%` would
// require a word char to follow, which made "24.9%" unmatchable at end of
// sentence/before space. Word units keep the \b so "5 kgx" doesn't match.
const STAT_RE =
  /(?:[$€£]\s?\d[\d,.]*(?:\s?(?:million|billion|trillion|thousand|[mbk]))?)|(?:\b\d[\d,.]*\s?(?:%|(?:percent|percentage points?|million|billion|trillion|thousand|kg|km|mi|lbs?|GB|MB|TB|ms|seconds?|minutes?|hours?|days?|weeks?|months?|years?|users?|customers?|employees?|countries|times|x)\b))/gi;

const AUTHORITATIVE_HINTS = /\.(gov|edu)(\/|$)|wikipedia\.org|nih\.gov|nature\.com|sciencedirect\.com|acm\.org|ieee\.org|arxiv\.org|who\.int|oecd\.org|reuters\.com|apnews\.com/i;

export function checkEvidenceDensity(ctx: AuditContext): DimensionResult {
  const dim = 'Evidence density';
  const html = ctx.target?.html ?? null;
  if (html === null) {
    return {
      key: 'evidenceDensity',
      name: dim,
      weight: 3,
      score: null,
      evidence: [{ status: 'unverified', message: 'could not verify — page HTML unavailable' }],
      recommendations: [],
    };
  }

  const evidence: Evidence[] = [];
  const recommendations: Recommendation[] = [];
  const mainHtml = mainContentHtml(html);
  const text = extractVisibleText(mainHtml);
  const words = wordCount(text);

  // No extractable text → the score is honestly 0, but stat/quote/citation
  // recommendations would be mis-aimed at an empty shell. Point at the root
  // cause instead.
  if (words < 15) {
    return {
      key: 'evidenceDensity',
      name: dim,
      weight: 3,
      score: 0,
      evidence: [
        { status: 'fail', message: `no extractable main content to assess (${words} words)` },
        { status: 'info', message: 'content-level checks scored the URL you gave; if the content lives elsewhere (e.g. /about or a docs page), audit that page directly' },
      ],
      recommendations: [
        {
          dimension: dim,
          action: 'Get real text into this page first (see Renderability), or run the audit against the page that actually carries your content',
          why: 'Statistics, quotations and citations (the GEO-research visibility levers) can only lift content that engines can extract — there is no text here to enrich.',
          impact: 3,
          effort: 1,
        },
      ],
    };
  }

  // Statistics (0-35)
  const stats = text.match(STAT_RE) ?? [];
  let statPts = 0;
  if (stats.length >= 6) statPts = 35;
  else if (stats.length >= 3) statPts = 25;
  else if (stats.length >= 1) statPts = 12;
  evidence.push({
    status: stats.length >= 3 ? 'pass' : stats.length >= 1 ? 'warn' : 'fail',
    message: `${stats.length} statistic(s) in main content${stats.length ? ` (e.g. "${stats.slice(0, 3).join('", "')}")` : ''}`,
  });
  if (stats.length < 3) {
    recommendations.push({
      dimension: dim,
      action: 'Add concrete statistics with units (%, $, counts) to the main content',
      why: 'The GEO research (Aggarwal et al., KDD 2024) measured a +25.9% generative-engine visibility lift from adding statistics (benchmark-specific — treat as directional, not guaranteed); engines preferentially quote sentences that carry numbers.',
      impact: 3,
      effort: 2,
    });
  }

  // Quotations (0-30)
  const blockquotes = countTag(mainHtml, 'blockquote');
  const quotedSpans = (text.match(/[“"]([^”"]{20,400})[”"]/g) ?? []).filter((q) => wordCount(q) >= 5);
  const quoteCount = blockquotes + quotedSpans.length;
  let quotePts = 0;
  if (quoteCount >= 3) quotePts = 30;
  else if (quoteCount >= 1) quotePts = 18;
  evidence.push({
    status: quoteCount >= 1 ? 'pass' : 'fail',
    message: `${quoteCount} quotation(s) (${blockquotes} <blockquote>, ${quotedSpans.length} inline quoted span(s) ≥5 words)`,
  });
  if (quoteCount === 0) {
    recommendations.push({
      dimension: dim,
      action: 'Quote named experts or primary sources directly (blockquote or inline quotation marks with attribution)',
      why: 'Quotations produced the single largest lift in the GEO research: +27.8% generative-engine visibility (Aggarwal et al., KDD 2024; benchmark-specific — treat as directional). Attributed speech reads as sourced rather than asserted.',
      impact: 3,
      effort: 2,
    });
  }

  // Outbound citations (0-35)
  const pageHost = safeHost(ctx.target!.url);
  const links = extractLinks(mainHtml);
  const outbound = links.filter((l) => {
    if (!/^https?:\/\//i.test(l.href)) return false;
    const host = safeHost(l.href);
    return host !== null && pageHost !== null && stripWww(host) !== stripWww(pageHost);
  });
  const authoritative = outbound.filter((l) => AUTHORITATIVE_HINTS.test(l.href));
  let citePts = 0;
  if (outbound.length >= 5) citePts = 30;
  else if (outbound.length >= 2) citePts = 20;
  else if (outbound.length >= 1) citePts = 10;
  if (authoritative.length >= 1) citePts += 5;
  evidence.push({
    status: outbound.length >= 2 ? 'pass' : outbound.length >= 1 ? 'warn' : 'fail',
    message: `${outbound.length} outbound citation link(s) in main content${outbound.length ? ` (e.g. ${outbound.slice(0, 2).map((l) => l.href).join(', ')})` : ''}`,
  });
  if (authoritative.length > 0) {
    evidence.push({ status: 'pass', message: `${authoritative.length} link(s) to recognizably authoritative domains (.gov/.edu/journals/wire services)` });
  }
  if (outbound.length < 2) {
    recommendations.push({
      dimension: dim,
      action: 'Cite sources: link claims to authoritative external references (.gov, .edu, journals, primary data)',
      why: 'Citing sources lifted generative-engine visibility +24.9% in the GEO research (Aggarwal et al., KDD 2024; benchmark-specific — treat as directional) — engines trust and re-surface content that shows its work.',
      impact: 3,
      effort: 1,
    });
  }

  evidence.push({ status: 'info', message: `main content length: ${words} words` });
  if (words < 150) {
    evidence.push({ status: 'warn', message: 'main content is very short — density signals are weak on thin pages' });
  }

  const score = Math.max(0, Math.min(100, statPts + quotePts + citePts));
  return { key: 'evidenceDensity', name: dim, weight: 3, score, evidence, recommendations };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function stripWww(host: string): string {
  return host.replace(/^www\./, '');
}
