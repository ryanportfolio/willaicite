import type { AuditContext } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { detectEmptyShell, extractVisibleText, noscriptText } from '../html.js';

/**
 * Heuristic renderability: how much content is visible in the raw HTML with no
 * JS execution — which is how GPTBot, ClaudeBot and PerplexityBot see the page
 * (none of them execute JavaScript; Googlebot does, but AI Overviews still
 * favor server-rendered text).
 */
export function checkRenderability(ctx: AuditContext): DimensionResult {
  const evidence: Evidence[] = [];
  const recommendations: Recommendation[] = [];
  const dim = 'Renderability';
  const html = ctx.target?.html ?? null;

  if (html === null) {
    return {
      key: 'renderability',
      name: dim,
      weight: 3,
      score: null,
      evidence: [{ status: 'unverified', message: `could not verify: page HTML unavailable (${ctx.target?.fetch.error ?? ctx.targetSkippedReason ?? 'fetch failed'})` }],
      recommendations,
    };
  }

  const text = extractVisibleText(html);
  const textLen = text.length;
  const htmlLen = html.length;
  const ratio = htmlLen > 0 ? textLen / htmlLen : 0;
  const shell = detectEmptyShell(html);
  const noscript = noscriptText(html);
  const scriptCount = (html.match(/<script\b/gi) ?? []).length;

  // Text volume: 0-50
  let textPts = 0;
  if (textLen >= 2000) textPts = 50;
  else if (textLen >= 800) textPts = 40;
  else if (textLen >= 400) textPts = 25;
  else if (textLen >= 150) textPts = 10;
  evidence.push({
    status: textLen >= 800 ? 'pass' : textLen >= 400 ? 'warn' : 'fail',
    message: `${textLen} chars of visible text extractable from raw HTML (no JS execution)`,
  });

  // Text/HTML ratio: 0-25
  let ratioPts = 0;
  if (ratio >= 0.1) ratioPts = 25;
  else if (ratio >= 0.05) ratioPts = 15;
  else if (ratio >= 0.02) ratioPts = 8;
  evidence.push({
    status: ratio >= 0.05 ? 'pass' : ratio >= 0.02 ? 'warn' : 'fail',
    message: `text-to-HTML ratio ${(ratio * 100).toFixed(1)}% (${textLen} / ${htmlLen} bytes)`,
  });

  // Shell detection: 0-25
  let shellPts = 25;
  if (shell) {
    shellPts = 0;
    evidence.push({
      status: 'fail',
      message: `empty SPA shell detected (mount point ${shell} with almost no server-rendered text); invisible to ChatGPT, Claude and Perplexity crawlers, which do not execute JavaScript; Googlebot can render JS, so Google AI surfaces may still see the hydrated content`,
    });
  } else {
    evidence.push({ status: 'pass', message: 'no empty SPA shell detected' });
  }

  if (/enable\s+javascript|javascript\s+(is\s+)?(required|disabled)/i.test(noscript)) {
    evidence.push({ status: 'warn', message: `noscript fallback says "${noscript.slice(0, 80)}"; confirms the page depends on JS to render` });
  }
  evidence.push({ status: 'info', message: `${scriptCount} <script> tags on the page` });
  evidence.push({
    status: 'info',
    message: 'limitation: heuristic on raw HTML only; geo-audit does not execute JS, so hydrated-but-server-rendered pages are judged fairly, while lazy-loaded sections may be undercounted',
  });

  let score = Math.min(100, textPts + ratioPts + shellPts);
  if (shell) score = Math.min(score, 20);

  if (shell) {
    recommendations.push({
      dimension: dim,
      action: 'Put content in the initial HTML: cheapest first is a static H1 + a 1-2 sentence description in the shell before hydration, or make a static page (e.g. /about) the canonical marketing surface; full SSR/SSG only if the whole app needs indexing',
      why: 'GPTBot, ClaudeBot and PerplexityBot do not execute JavaScript; content that only appears after hydration is literally absent from what those crawlers retrieve, so it can never be cited. Even a static paragraph in the shell gives them something to index.',
      impact: 3,
      effort: 2,
    });
  } else if (textLen < 400) {
    recommendations.push({
      dimension: dim,
      action: 'Publish substantive text content in the initial HTML (the page currently serves very little extractable text)',
      why: 'Retrieval works on extractable text; a page with almost none gives answer engines nothing to chunk, rank, or cite, regardless of how it renders for humans.',
      impact: 3,
      effort: 2,
    });
  } else if (ratio < 0.05) {
    recommendations.push({
      dimension: dim,
      action: 'Reduce markup/script bloat relative to content (trim inline scripts, defer non-critical JS)',
      why: 'A low text-to-HTML ratio means crawlers spend their fetch budget on boilerplate; extraction pipelines that isolate main content have less clean text to work with.',
      impact: 1,
      effort: 2,
    });
  }

  return { key: 'renderability', name: dim, weight: 3, score: Math.round(score), evidence, recommendations };
}
