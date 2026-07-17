import { describe, it, expect } from 'vitest';
import { overallScore, verdictFor, prioritize } from '../src/score.js';
import { buildResult } from '../src/audit.js';
import { renderMarkdown, renderJson } from '../src/report.js';
import { makeCtx, makePage, makeFetch, fixture, NOW } from './helpers.js';
import type { DimensionResult } from '../src/types.js';

function dim(over: Partial<DimensionResult>): DimensionResult {
  return { key: 'k', name: 'n', weight: 2, score: 50, evidence: [], recommendations: [], ...over };
}

describe('overallScore', () => {
  it('weights dimensions', () => {
    expect(overallScore([dim({ score: 100, weight: 3 }), dim({ score: 0, weight: 1 })])).toBe(75);
  });

  it('renormalizes over verifiable dimensions (null excluded, never counted as 0)', () => {
    expect(overallScore([dim({ score: 80, weight: 3 }), dim({ score: null, weight: 3 })])).toBe(80);
  });

  it('returns null when nothing is scoreable', () => {
    expect(overallScore([dim({ score: null })])).toBeNull();
  });
});

describe('verdictFor', () => {
  it('maps bands to verdicts', () => {
    expect(verdictFor(90)).toContain('Excellent');
    expect(verdictFor(72)).toContain('Good');
    expect(verdictFor(55)).toContain('Needs work');
    expect(verdictFor(20)).toContain('Poor');
    expect(verdictFor(null)).toContain('Could not verify');
  });
});

describe('prioritize', () => {
  it('orders by impact-per-effort, then impact, deterministically', () => {
    const d = dim({
      recommendations: [
        { dimension: 'n', action: 'slow big', why: 'w', impact: 3, effort: 3 },
        { dimension: 'n', action: 'quick win', why: 'w', impact: 3, effort: 1 },
        { dimension: 'n', action: 'medium', why: 'w', impact: 2, effort: 1 },
        { dimension: 'n', action: 'cheap small', why: 'w', impact: 1, effort: 1 },
      ],
    });
    const order = prioritize([d]).map((r) => r.action);
    expect(order).toEqual(['quick win', 'medium', 'slow big', 'cheap small']);
  });

  it('collapses identical actions from different dimensions into one entry tagged with both', () => {
    const a = dim({
      name: 'Answer-readiness',
      recommendations: [{ dimension: 'Answer-readiness', action: 'Get real text into this page first', why: 'w1', impact: 3, effort: 1 }],
    });
    const b = dim({
      name: 'Evidence density',
      recommendations: [{ dimension: 'Evidence density', action: 'Get real text into this page first', why: 'w2', impact: 3, effort: 1 }],
    });
    const out = prioritize([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].dimension).toBe('Answer-readiness + Evidence density');
    // and the source recommendation objects are not mutated
    expect(a.recommendations[0].dimension).toBe('Answer-readiness');
  });
});

describe('buildResult + renderMarkdown (integration, no network)', () => {
  const result = buildResult('https://example.com/guide', makeCtx(), NOW);

  it('produces a high overall score for the good-article context', () => {
    expect(result.overallScore).toBeGreaterThanOrEqual(85);
    expect(result.dimensions).toHaveLength(7);
  });

  it('renders markdown with overall score, table, and limitations', () => {
    const md = renderMarkdown(result);
    expect(md).toContain('# GEO Audit — https://example.com/guide');
    expect(md).toContain(`## Overall score: ${result.overallScore}/100`);
    expect(md).toContain('| AI crawler access | high |');
    expect(md).toContain('## Limitations');
    expect(md).toContain('No live AI-engine querying');
  });

  it('renders valid JSON with a fixFirst list', () => {
    const parsed = JSON.parse(renderJson(result));
    expect(parsed.overallScore).toBe(result.overallScore);
    expect(Array.isArray(parsed.fixFirst)).toBe(true);
    expect(parsed.dimensions).toHaveLength(7);
  });

  it('never fabricates: unverifiable context yields could-not-verify, not scores', () => {
    const ctx = makeCtx({
      target: null,
      targetSkippedReason: null,
      targetBotFetch: null,
      aboutPage: null,
      robots: { url: 'https://example.com/robots.txt', fetch: makeFetch({ ok: false, status: null, error: 'timeout' }), parsed: null },
      llmsTxt: { url: 'https://example.com/llms.txt', fetch: makeFetch({ ok: false, status: null, error: 'timeout' }) },
    });
    const r = buildResult('https://example.com/guide', ctx, NOW);
    for (const d of r.dimensions) {
      expect(d.score).toBeNull();
    }
    expect(r.overallScore).toBeNull();
    const md = renderMarkdown(r);
    expect(md).toContain('## Overall score: could not verify');
  });

  it('markdown report degrades per-dimension when only one page part is missing', () => {
    const ctx = makeCtx({ target: makePage('https://example.com/guide', fixture('spa-shell.html')) });
    const r = buildResult('https://example.com/guide', ctx, NOW);
    const render = r.dimensions.find((d) => d.key === 'renderability');
    expect(render?.score).toBeLessThanOrEqual(20);
    // crawler access still scoreable
    expect(r.dimensions.find((d) => d.key === 'crawlerAccess')?.score).not.toBeNull();
  });
});
