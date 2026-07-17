import type { AuditResult, DimensionResult, Evidence, Recommendation } from './types.js';
import { prioritize } from './score.js';

const STATUS_ICON: Record<Evidence['status'], string> = {
  pass: '✅',
  fail: '❌',
  warn: '⚠️',
  info: 'ℹ️',
  unverified: '❔',
};

const LEVEL: Record<number, string> = { 1: 'low', 2: 'medium', 3: 'high' };

export function renderMarkdown(result: AuditResult): string {
  const lines: string[] = [];
  const score = result.overallScore;

  lines.push(`# GEO Audit: ${result.url}`);
  lines.push('');
  lines.push(`## Overall score: ${score === null ? 'could not verify' : `${score}/100`}`);
  lines.push('');
  lines.push(`**${result.verdict}**`);
  lines.push('');
  lines.push(`Audited ${result.pagesAudited.length} page(s) on ${result.fetchedAt} with ${result.tool} v${result.version}.`);
  if (result.finalUrl && result.finalUrl !== result.url) {
    lines.push(`Resolved to: ${result.finalUrl}`);
  }
  lines.push('');

  // Score table
  lines.push('| Dimension | Weight | Score |');
  lines.push('|---|---|---|');
  for (const d of result.dimensions) {
    lines.push(`| ${d.name} | ${weightLabel(d.weight)} | ${d.score === null ? 'could not verify' : `${d.score}/100`} |`);
  }
  lines.push('');

  // Fix first
  const fixes = prioritize(result.dimensions).concat(prioritize(result.informational));
  if (fixes.length > 0) {
    lines.push('## Fix first (by impact-per-effort)');
    lines.push('');
    fixes.forEach((rec, i) => {
      lines.push(`${i + 1}. **${rec.action}** _(${rec.dimension}; impact ${LEVEL[rec.impact]}, effort ${LEVEL[rec.effort]})_`);
      lines.push(`   - Why: ${rec.why}`);
    });
    lines.push('');
  } else {
    lines.push('## Fix first');
    lines.push('');
    lines.push('No recommendations: every verifiable check passed.');
    lines.push('');
  }

  // Per-dimension detail
  lines.push('## Dimension detail');
  lines.push('');
  for (const d of result.dimensions) {
    lines.push(...renderDimension(d));
  }

  lines.push('## Informational (unscored)');
  lines.push('');
  for (const d of result.informational) {
    lines.push(...renderDimension(d, false));
  }

  lines.push('## Limitations');
  lines.push('');
  for (const l of result.limitations) {
    lines.push(`- ${l}`);
  }
  lines.push('');

  return lines.join('\n');
}

function renderDimension(d: DimensionResult, scored = true): string[] {
  const lines: string[] = [];
  const scoreLabel = !scored ? '' : d.score === null ? ': could not verify' : `: ${d.score}/100`;
  lines.push(`### ${d.name}${scoreLabel}${scored ? ` (weight: ${weightLabel(d.weight)})` : ''}`);
  lines.push('');
  for (const e of d.evidence) {
    lines.push(`- ${STATUS_ICON[e.status]} ${e.message}`);
  }
  if (d.recommendations.length > 0) {
    lines.push('');
    lines.push('**Recommendations:**');
    for (const r of d.recommendations) {
      lines.push(`- ${r.action}: _${r.why}_`);
    }
  }
  lines.push('');
  return lines;
}

function weightLabel(weight: number): string {
  if (weight >= 3) return 'high';
  if (weight === 2) return 'medium';
  if (weight === 1) return 'low';
  return 'informational';
}

export function renderJson(result: AuditResult): string {
  const fixFirst = prioritize(result.dimensions).concat(prioritize(result.informational));
  return JSON.stringify({ ...result, fixFirst }, null, 2);
}

export type { Recommendation };
