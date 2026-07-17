import { describe, it, expect } from 'vitest';
import { buildResult } from '../src/audit.js';
import { makeCtx, makePage, fixture, NOW } from './helpers.js';

/**
 * Golden score corpus. These exact numbers ARE the scoring model: any
 * heuristic change that moves them must be a conscious recalibration —
 * update the pins AND bump the tool version (scores are only comparable
 * within one scoring-model version, see README).
 */

function scoresOf(ctx: ReturnType<typeof makeCtx>) {
  const r = buildResult('https://example.com/guide', ctx, NOW);
  return {
    overall: r.overallScore,
    ...Object.fromEntries(r.dimensions.map((d) => [d.key, d.score])),
  };
}

describe('golden scores (scoring-model regression pins)', () => {
  it('rich article context', () => {
    expect(scoresOf(makeCtx())).toEqual({
      overall: 99,
      crawlerAccess: 100,
      renderability: 90,
      structuredData: 100,
      answerReadiness: 100,
      topicalFocus: 100,
      evidenceDensity: 100,
      freshness: 100,
      entityEeat: 100,
    });
  });

  it('thin page context', () => {
    expect(scoresOf(makeCtx({ target: makePage('https://example.com/guide', fixture('thin-page.html')) }))).toEqual({
      overall: 33,
      crawlerAccess: 100,
      renderability: 50,
      structuredData: 0,
      answerReadiness: 5,
      topicalFocus: 10,
      evidenceDensity: 0,
      freshness: 30,
      entityEeat: 50,
    });
  });

  it('empty SPA shell context', () => {
    expect(scoresOf(makeCtx({ target: makePage('https://example.com/guide', fixture('spa-shell.html')) }))).toEqual({
      overall: 25,
      crawlerAccess: 100,
      renderability: 0,
      structuredData: 0,
      answerReadiness: 0,
      topicalFocus: 10,
      evidenceDensity: 0,
      freshness: 30,
      entityEeat: 50,
    });
  });
});
