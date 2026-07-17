import type { DimensionResult, Recommendation } from './types.js';

/**
 * Weighted overall score over the dimensions that could actually be verified.
 * Weights renormalize over scoreable dimensions so an unverifiable check never
 * silently drags the score to zero — it is reported as "could not verify"
 * instead.
 */
export function overallScore(dimensions: DimensionResult[]): number | null {
  const scoreable = dimensions.filter((d) => d.score !== null && d.weight > 0);
  if (scoreable.length === 0) return null;
  const totalWeight = scoreable.reduce((sum, d) => sum + d.weight, 0);
  const weighted = scoreable.reduce((sum, d) => sum + (d.score as number) * d.weight, 0);
  return Math.round(weighted / totalWeight);
}

export function verdictFor(score: number | null): string {
  if (score === null) return 'Could not verify — the audit was unable to score any dimension.';
  if (score >= 85) return 'Excellent — well positioned to be retrieved and cited by AI answer engines.';
  if (score >= 70) return 'Good — solid GEO foundation with a few addressable gaps.';
  if (score >= 50) return 'Needs work — real gaps are limiting how AI engines retrieve and cite this site.';
  return 'Poor — this site is largely invisible or unciteable to AI answer engines as-is.';
}

/**
 * Prioritized "fix first" ordering: impact-per-effort first, then raw impact,
 * then the weight of the dimension it belongs to. Deterministic tie-break on
 * the action text.
 */
export function prioritize(dimensions: DimensionResult[]): Recommendation[] {
  const weightOf = new Map(dimensions.map((d) => [d.name, d.weight]));
  const all = dimensions.flatMap((d) => d.recommendations);
  return [...all].sort((a, b) => {
    const ratio = b.impact / b.effort - a.impact / a.effort;
    if (ratio !== 0) return ratio;
    if (b.impact !== a.impact) return b.impact - a.impact;
    const wa = weightOf.get(a.dimension) ?? 0;
    const wb = weightOf.get(b.dimension) ?? 0;
    if (wb !== wa) return wb - wa;
    return a.action.localeCompare(b.action);
  });
}
