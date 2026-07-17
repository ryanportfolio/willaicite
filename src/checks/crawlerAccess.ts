import type { AuditContext } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { isAllowed } from '../robots.js';
import { findMeta } from '../html.js';

/**
 * Retrieval-class bots fetch pages to answer live queries or fill a search
 * index — blocking one means that engine can never retrieve or cite the page.
 * Training-class tokens only control model-training data collection (two of
 * them, Google-Extended and Applebot-Extended, are pure opt-out tokens with no
 * crawler behind them); blocking those is a mainstream content policy with a
 * much smaller citation cost, so it is penalized far more lightly.
 *
 * `robotsIgnored`: the operator documents that this fetcher generally ignores
 * robots.txt (user-initiated), so a Disallow records intent without stopping
 * retrieval — it is scored as a light advisory, never as a hard block.
 * `caveat`: appended to blocked-evidence so the stake line stays factual.
 */
export const AI_BOTS: { token: string; engine: string; role: 'retrieval' | 'training'; robotsIgnored?: boolean; caveat?: string }[] = [
  { token: 'OAI-SearchBot', engine: 'ChatGPT Search index', role: 'retrieval' },
  { token: 'ChatGPT-User', engine: 'ChatGPT live browsing', role: 'retrieval' },
  { token: 'Claude-SearchBot', engine: 'Claude search index', role: 'retrieval' },
  { token: 'Claude-User', engine: 'Claude live browsing', role: 'retrieval' },
  { token: 'PerplexityBot', engine: 'Perplexity index', role: 'retrieval' },
  {
    token: 'Perplexity-User',
    engine: 'Perplexity live fetch (sends real referrals)',
    role: 'retrieval',
    robotsIgnored: true,
    caveat: 'Perplexity documents that user-initiated fetches generally ignore robots.txt, so this rule records intent but does not stop retrieval',
  },
  { token: 'Bingbot', engine: 'Bing index (feeds Copilot and, residually, ChatGPT answers)', role: 'retrieval' },
  { token: 'Amazonbot', engine: 'Alexa / Rufus answers', role: 'retrieval' },
  { token: 'DuckAssistBot', engine: 'DuckDuckGo AI answers', role: 'retrieval' },
  { token: 'Applebot', engine: 'Siri / Spotlight / Apple Intelligence retrieval', role: 'retrieval' },
  { token: 'MistralAI-User', engine: 'Le Chat live fetch', role: 'retrieval' },
  { token: 'GPTBot', engine: 'OpenAI model training', role: 'training' },
  { token: 'ClaudeBot', engine: 'Anthropic model training', role: 'training' },
  { token: 'CCBot', engine: 'Common Crawl (feeds many training sets)', role: 'training' },
  { token: 'meta-externalagent', engine: 'Meta AI training', role: 'training' },
  {
    token: 'Google-Extended',
    engine: 'Gemini training + grounding opt-out token (no crawler)',
    role: 'training',
    caveat: 'this token also gates Gemini grounding: blocking it stops Gemini from pulling and citing this content at answer time, not just from training on it',
  },
  { token: 'Applebot-Extended', engine: 'Apple Intelligence training opt-out token (no crawler)', role: 'training' },
];

const RETRIEVAL_PENALTY = 14;
const TRAINING_PENALTY = 4;
const ADVISORY_PENALTY = 2;

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
      message: `no robots.txt (HTTP ${ctx.robots.fetch.status}); all crawlers allowed by default`,
    });
  } else {
    verifiable = true;
    const blockedRetrieval: string[] = [];
    const blockedTraining: string[] = [];
    const blockedAdvisory: string[] = [];
    const allowed: Record<'retrieval' | 'training', string[]> = { retrieval: [], training: [] };
    for (const bot of AI_BOTS) {
      const decision = isAllowed(ctx.robots.parsed, bot.token, path);
      if (decision.allowed) {
        allowed[bot.role].push(bot.token);
        continue;
      }
      const ruleText = decision.rule ? `robots.txt line ${decision.rule.line}: \`${decision.rule.raw}\`` : 'robots.txt rule';
      const via = decision.viaGroup === '*' ? 'via wildcard `User-agent: *` group' : `via \`User-agent: ${decision.viaGroup}\` group`;
      const caveat = bot.caveat ? `. Note: ${bot.caveat}` : '';
      if (bot.robotsIgnored) {
        blockedAdvisory.push(bot.token);
        evidence.push({
          status: 'warn',
          message: `${bot.token} disallowed for ${path}: ${ruleText} (${via})${caveat}. Engine: ${bot.engine}`,
        });
        score -= ADVISORY_PENALTY;
        continue;
      }
      (bot.role === 'retrieval' ? blockedRetrieval : blockedTraining).push(bot.token);
      const stake = bot.role === 'retrieval' ? 'Engine affected' : 'Training pipeline affected';
      evidence.push({
        status: bot.role === 'retrieval' ? 'fail' : 'warn',
        message: `${bot.token} BLOCKED for ${path}: ${ruleText} (${via}). ${stake}: ${bot.engine}${caveat}`,
      });
      score -= bot.role === 'retrieval' ? RETRIEVAL_PENALTY : TRAINING_PENALTY;
    }
    if (allowed.retrieval.length > 0) {
      evidence.push({ status: 'pass', message: `${allowed.retrieval.length} retrieval/citation crawler(s) allowed: ${allowed.retrieval.join(', ')}` });
    }
    if (allowed.training.length > 0) {
      evidence.push({ status: 'pass', message: `${allowed.training.length} training crawler(s)/opt-out token(s) allowed: ${allowed.training.join(', ')}` });
    }
    if (blockedRetrieval.length > 0) {
      recommendations.push({
        dimension: dim,
        action: `Unblock ${blockedRetrieval.join(', ')} in robots.txt (or add explicit Allow rules for this path)`,
        why: 'A retrieval crawler blocked in robots.txt cannot fetch the page at all, so the engine behind it can never retrieve or cite this content. This is the single hardest gate in GEO; every other optimization is irrelevant to an engine whose crawler is blocked.',
        impact: 3,
        effort: 1,
      });
    }
    if (blockedTraining.length > 0) {
      const groundingException = blockedTraining.includes('Google-Extended')
        ? ' Exception: Google-Extended also gates Gemini grounding, so Gemini citations of this content do stop while it is blocked.'
        : '';
      recommendations.push({
        dimension: dim,
        action: `Confirm blocking ${blockedTraining.join(', ')} is a deliberate policy choice (training-only tokens)`,
        why: `Blocking training crawlers is a legitimate, now-mainstream content policy and does not stop AI engines from citing the page today, but it does keep the content out of future model knowledge, which slightly reduces long-term unprompted mentions. Keep it if intentional.${groundingException}`,
        impact: 1,
        effort: 1,
      });
    }
    if (blockedAdvisory.length > 0) {
      recommendations.push({
        dimension: dim,
        action: `If blocking ${blockedAdvisory.join(', ')} is intended, enforce it at the WAF/CDN; robots.txt alone does not stop user-initiated fetchers`,
        why: 'The operator documents that this fetcher generally ignores robots.txt because a human initiated the request. The Disallow line records intent without changing behavior; if you did not mean to block it, remove the rule to keep the declared policy accurate.',
        impact: 1,
        effort: 2,
      });
    }
    // Cloudflare Content Signals policy (informational; a robots.txt-level
    // usage declaration some CDNs now emit alongside classic rules)
    const signalLine = (ctx.robots.fetch?.body ?? '').split(/\r?\n/).find((l) => /^\s*content-signal\s*:/i.test(l));
    if (signalLine) {
      evidence.push({ status: 'info', message: `robots.txt declares a Content Signals policy: \`${signalLine.trim()}\` (advisory usage signal, not an access rule)` });
    }
  }

  // Meta robots + X-Robots-Tag
  const html = ctx.target?.html ?? null;
  if (html !== null) {
    verifiable = true;
    const metaRobots = findMeta(html, 'robots');
    if (metaRobots && /\b(noindex|none)\b/i.test(metaRobots)) {
      score -= 30;
      evidence.push({ status: 'fail', message: `meta robots tag contains "${metaRobots}"; page opts out of indexing` });
      recommendations.push({
        dimension: dim,
        action: 'Remove noindex from the meta robots tag',
        why: 'noindex removes the page from search indexes that AI engines retrieve from (Bing feeds ChatGPT, Google feeds AI Overviews), so the page cannot appear in AI answers even if crawlers can fetch it.',
        impact: 3,
        effort: 1,
      });
    } else {
      evidence.push({ status: 'pass', message: metaRobots ? `meta robots present ("${metaRobots}"); no noindex` : 'no meta robots restriction' });
    }
  } else {
    evidence.push({ status: 'unverified', message: 'could not verify meta robots (page HTML unavailable)' });
  }

  const xRobots = ctx.target?.fetch.headers['x-robots-tag'] ?? null;
  if (ctx.target) {
    if (xRobots && /\b(noindex|none)\b/i.test(xRobots)) {
      score -= 30;
      evidence.push({ status: 'fail', message: `X-Robots-Tag header: "${xRobots}"; page opts out of indexing at the HTTP level` });
      recommendations.push({
        dimension: dim,
        action: 'Remove noindex from the X-Robots-Tag response header',
        why: 'The header applies before HTML is parsed; it removes the page from the indexes AI engines retrieve from regardless of on-page tags.',
        impact: 3,
        effort: 1,
      });
    } else {
      evidence.push({ status: 'pass', message: xRobots ? `X-Robots-Tag present ("${xRobots}"); no noindex` : 'no X-Robots-Tag restriction' });
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
        message: `UA differential: normal UA got HTTP ${normal.status}, GPTBot UA got HTTP ${bot.status}; a CDN/WAF is treating AI crawlers differently`,
      });
      recommendations.push({
        dimension: dim,
        action: 'Check CDN/WAF bot-management rules (Cloudflare "Block AI bots", Akamai bot manager, etc.) and allow AI crawler user agents',
        why: `robots.txt may say "allowed" while the WAF returns ${bot.status} to the actual crawler; the engine sees the error, not the content, and silently drops the page from its index.`,
        impact: 3,
        effort: 2,
      });
    } else {
      evidence.push({ status: 'pass', message: `UA differential: normal UA and GPTBot UA both got HTTP ${normal.status}; no WAF-level bot blocking detected` });
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
