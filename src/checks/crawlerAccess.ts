import type { AuditContext } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { isAllowed } from '../robots.js';
import { findMeta } from '../html.js';

export const AI_BOTS: { token: string; engine: string }[] = [
  { token: 'GPTBot', engine: 'ChatGPT training + search index' },
  { token: 'OAI-SearchBot', engine: 'ChatGPT Search' },
  { token: 'ChatGPT-User', engine: 'ChatGPT live browsing' },
  { token: 'ClaudeBot', engine: 'Claude training crawl' },
  { token: 'Claude-SearchBot', engine: 'Claude search' },
  { token: 'PerplexityBot', engine: 'Perplexity index' },
  { token: 'Google-Extended', engine: 'Gemini training / grounding' },
  { token: 'Bingbot', engine: 'Bing index (feeds ChatGPT + Copilot answers)' },
];

export function checkCrawlerAccess(ctx: AuditContext): DimensionResult {
  const evidence: Evidence[] = [];
  const recommendations: Recommendation[] = [];
  const dim = 'AI crawler access';
  let score = 100;
  let verifiable = false;

  const path = pathOf(ctx.targetUrl);

  // robots.txt per-bot verdicts
  if (ctx.robots.fetch === null || (ctx.robots.fetch.error && ctx.robots.fetch.status === null)) {
    evidence.push({
      status: 'unverified',
      message: `could not verify robots.txt (${ctx.robots.fetch?.error ?? 'not fetched'})`,
    });
  } else if (ctx.robots.parsed === null) {
    verifiable = true;
    evidence.push({
      status: 'pass',
      message: `no robots.txt (HTTP ${ctx.robots.fetch.status}) — all crawlers allowed by default`,
    });
  } else {
    verifiable = true;
    const blocked: string[] = [];
    for (const bot of AI_BOTS) {
      const decision = isAllowed(ctx.robots.parsed, bot.token, path);
      if (decision.allowed) {
        evidence.push({ status: 'pass', message: `${bot.token} allowed (${bot.engine})` });
      } else {
        blocked.push(bot.token);
        const ruleText = decision.rule ? `robots.txt line ${decision.rule.line}: \`${decision.rule.raw}\`` : 'robots.txt rule';
        const via = decision.viaGroup === '*' ? 'via wildcard `User-agent: *` group' : `via \`User-agent: ${decision.viaGroup}\` group`;
        evidence.push({ status: 'fail', message: `${bot.token} BLOCKED for ${path} — ${ruleText} (${via}). Engine affected: ${bot.engine}` });
        score -= 12;
      }
    }
    if (blocked.length > 0) {
      recommendations.push({
        dimension: dim,
        action: `Unblock ${blocked.join(', ')} in robots.txt (or add explicit Allow rules for this path)`,
        why: 'A crawler blocked in robots.txt cannot fetch the page at all, so the engine behind it can never retrieve or cite this content. This is the single hardest gate in GEO — every other optimization is irrelevant to an engine whose crawler is blocked.',
        impact: 3,
        effort: 1,
      });
    }
  }

  // Meta robots + X-Robots-Tag
  const html = ctx.target?.html ?? null;
  if (html !== null) {
    verifiable = true;
    const metaRobots = findMeta(html, 'robots');
    if (metaRobots && /\b(noindex|none)\b/i.test(metaRobots)) {
      score -= 30;
      evidence.push({ status: 'fail', message: `meta robots tag contains "${metaRobots}" — page opts out of indexing` });
      recommendations.push({
        dimension: dim,
        action: 'Remove noindex from the meta robots tag',
        why: 'noindex removes the page from search indexes that AI engines retrieve from (Bing feeds ChatGPT, Google feeds AI Overviews), so the page cannot appear in AI answers even if crawlers can fetch it.',
        impact: 3,
        effort: 1,
      });
    } else {
      evidence.push({ status: 'pass', message: metaRobots ? `meta robots present ("${metaRobots}") — no noindex` : 'no meta robots restriction' });
    }
  } else {
    evidence.push({ status: 'unverified', message: 'could not verify meta robots (page HTML unavailable)' });
  }

  const xRobots = ctx.target?.fetch.headers['x-robots-tag'] ?? null;
  if (ctx.target) {
    if (xRobots && /\b(noindex|none)\b/i.test(xRobots)) {
      score -= 30;
      evidence.push({ status: 'fail', message: `X-Robots-Tag header: "${xRobots}" — page opts out of indexing at the HTTP level` });
      recommendations.push({
        dimension: dim,
        action: 'Remove noindex from the X-Robots-Tag response header',
        why: 'The header applies before HTML is parsed; it removes the page from the indexes AI engines retrieve from regardless of on-page tags.',
        impact: 3,
        effort: 1,
      });
    } else {
      evidence.push({ status: 'pass', message: xRobots ? `X-Robots-Tag present ("${xRobots}") — no noindex` : 'no X-Robots-Tag restriction' });
    }
  }

  // WAF / CDN differential: same URL, GPTBot UA vs normal UA
  const normal = ctx.target?.fetch ?? null;
  const bot = ctx.targetBotFetch;
  if (normal && normal.status !== null && bot && bot.status !== null) {
    verifiable = true;
    if (normal.status !== bot.status) {
      score -= 30;
      evidence.push({
        status: 'fail',
        message: `UA differential: normal UA got HTTP ${normal.status}, GPTBot UA got HTTP ${bot.status} — a CDN/WAF is treating AI crawlers differently`,
      });
      recommendations.push({
        dimension: dim,
        action: 'Check CDN/WAF bot-management rules (Cloudflare "Block AI bots", Akamai bot manager, etc.) and allow AI crawler user agents',
        why: `robots.txt may say "allowed" while the WAF returns ${bot.status} to the actual crawler — the engine sees the error, not the content, and silently drops the page from its index.`,
        impact: 3,
        effort: 2,
      });
    } else {
      evidence.push({ status: 'pass', message: `UA differential: normal UA and GPTBot UA both got HTTP ${normal.status} — no WAF-level bot blocking detected` });
    }
  } else if (bot?.error) {
    evidence.push({ status: 'unverified', message: `could not verify UA differential (GPTBot-UA fetch failed: ${bot.error})` });
  } else {
    evidence.push({ status: 'unverified', message: 'could not verify UA differential (fetch unavailable)' });
  }

  return {
    key: 'crawlerAccess',
    name: dim,
    weight: 3,
    score: verifiable ? clamp(score) : null,
    evidence,
    recommendations,
  };
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return '/';
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
