import type { AuditContext } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { isAllowed } from '../robots.js';
import { AI_BOTS } from './crawlerAccess.js';

/**
 * llms.txt — informational only, deliberately outside the seven scored
 * dimensions. Honest framing: ~10% adoption, the major AI crawlers mostly
 * skip it, but IDE coding agents and Lighthouse's agentic-browsing audit do
 * read it, and it costs nothing to add.
 */
export function checkLlmsTxt(ctx: AuditContext): DimensionResult {
  const dim = 'llms.txt (informational)';
  const evidence: Evidence[] = [];
  const recommendations: Recommendation[] = [];
  const fetch = ctx.llmsTxt.fetch;

  if (fetch === null || (fetch.error && fetch.status === null)) {
    evidence.push({ status: 'unverified', message: `could not verify llms.txt (${fetch?.error ?? 'not fetched'})` });
    return { key: 'llmsTxt', name: dim, weight: 0, score: null, evidence, recommendations };
  }

  if (fetch.status !== 200 || !fetch.body) {
    evidence.push({ status: 'info', message: `no llms.txt (${ctx.llmsTxt.url} → HTTP ${fetch.status})` });
    recommendations.push({
      dimension: dim,
      action: 'Optionally add an llms.txt (markdown index of your key pages) at the site root',
      why: 'Honest framing: adoption is ~10% and the major AI crawlers (GPTBot, ClaudeBot, PerplexityBot) mostly skip it today, but IDE coding agents and Lighthouse\'s agentic-browsing audit do read it, and it costs nothing to maintain. Low priority, zero downside.',
      impact: 1,
      effort: 1,
    });
    return { key: 'llmsTxt', name: dim, weight: 0, score: null, evidence, recommendations };
  }

  const body = fetch.body;
  const lines = body.split(/\r?\n/);
  const firstContent = lines.find((l) => l.trim().length > 0)?.trim() ?? '';
  const hasH1 = firstContent.startsWith('# ');
  const linkCount = (body.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  const looksLikeHtml = /^\s*<!doctype|^\s*<html/i.test(body);

  if (looksLikeHtml) {
    evidence.push({ status: 'warn', message: 'llms.txt URL returns HTML (likely a soft-404/SPA fallback), not a markdown file' });
    return { key: 'llmsTxt', name: dim, weight: 0, score: null, evidence, recommendations };
  }

  evidence.push({ status: 'pass', message: `llms.txt present (${body.length} bytes)` });
  if (hasH1) {
    evidence.push({ status: 'pass', message: `starts with an H1 as the spec expects: "${firstContent.slice(0, 80)}"` });
  } else {
    evidence.push({ status: 'warn', message: `first line is not an H1 ("# Site name"); spec expects one: "${firstContent.slice(0, 80)}"` });
  }
  evidence.push({
    status: linkCount > 0 ? 'pass' : 'warn',
    message: `${linkCount} markdown link(s); ${linkCount > 0 ? 'agents can follow the index' : 'an llms.txt without links gives agents nothing to follow'}`,
  });

  // Consistency with robots.txt: inviting LLMs via llms.txt while blocking their crawlers is contradictory.
  if (ctx.robots.parsed) {
    // Fetchers that document ignoring robots.txt can still read the invitation, so they are not a contradiction.
    const blocked = AI_BOTS.filter((b) => !b.robotsIgnored && !isAllowed(ctx.robots.parsed!, b.token, '/').allowed).map((b) => b.token);
    if (blocked.length > 0) {
      evidence.push({
        status: 'warn',
        message: `contradiction: llms.txt invites AI agents but robots.txt blocks ${blocked.join(', ')}; crawlers honor robots.txt, so the invitation is unreachable for them`,
      });
      recommendations.push({
        dimension: dim,
        action: 'Reconcile llms.txt with robots.txt (either unblock the AI crawlers or drop the llms.txt invitation)',
        why: 'robots.txt is the enforced signal; an llms.txt that contradicts it just documents an intention the blocked crawlers can never act on.',
        impact: 1,
        effort: 1,
      });
    } else {
      evidence.push({ status: 'pass', message: 'consistent with robots.txt (no AI crawlers blocked)' });
    }
  }

  evidence.push({
    status: 'info',
    message: 'context: ~10% adoption; GPTBot/ClaudeBot/PerplexityBot mostly skip llms.txt today; IDE coding agents and Lighthouse\'s agentic-browsing audit do use it',
  });

  return { key: 'llmsTxt', name: dim, weight: 0, score: null, evidence, recommendations };
}
