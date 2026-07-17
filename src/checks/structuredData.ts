import type { AuditContext } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { extractJsonLd, jsonLdTypes } from '../html.js';

/**
 * JSON-LD structured data. Weighted honestly: schema.org markup is strongest
 * for Google AI Overviews and entity/knowledge-graph trust; ChatGPT, Claude
 * and Perplexity largely tokenize the page rather than parse the graph. The
 * GEO-16 field audit (Kumar & Palkhouski 2025) did find structured data among
 * the pillars most strongly associated with real citations across Brave,
 * Google AI Overviews and Perplexity — but that evidence is correlational
 * (well-marked-up pages tend to be well-made pages), so the weight stays
 * medium rather than high.
 */
export function checkStructuredData(ctx: AuditContext): DimensionResult {
  const evidence: Evidence[] = [];
  const recommendations: Recommendation[] = [];
  const dim = 'Structured data';
  const pages = [ctx.target, ctx.homepage].filter((p): p is NonNullable<typeof p> => Boolean(p?.html));

  if (pages.length === 0) {
    return {
      key: 'structuredData',
      name: dim,
      weight: 2,
      score: null,
      evidence: [{ status: 'unverified', message: 'could not verify: no page HTML available' }],
      recommendations,
    };
  }

  const nodes: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let blockCount = 0;
  for (const page of pages) {
    const extracted = extractJsonLd(page.html!);
    nodes.push(...extracted.nodes);
    errors.push(...extracted.errors);
    blockCount += extracted.blockCount;
  }
  const types = jsonLdTypes(nodes);
  const has = (t: string) => types.includes(t.toLowerCase());

  let score = 0;

  if (blockCount === 0) {
    evidence.push({ status: 'fail', message: 'no JSON-LD blocks found on the audited pages' });
    recommendations.push({
      dimension: dim,
      action: 'Add JSON-LD structured data (start with Organization on the homepage and Article/BlogPosting on content pages)',
      why: 'Structured data is the strongest machine-readable trust signal for Google AI Overviews and knowledge-graph entity resolution, and the GEO-16 audit (Kumar & Palkhouski 2025) found it strongly associated with observed citations across three engines (correlational evidence). Honest caveat: ChatGPT, Claude and Perplexity mostly tokenize the visible text rather than parse the schema graph.',
      impact: 2,
      effort: 2,
    });
  } else {
    score += 20;
    evidence.push({ status: 'pass', message: `${blockCount} JSON-LD block(s) found, ${nodes.length} node(s) parsed` });
  }

  for (const err of errors) {
    score -= 10;
    evidence.push({ status: 'fail', message: `invalid JSON-LD block (JSON.parse failed): "${err}…"` });
  }
  if (errors.length > 0) {
    recommendations.push({
      dimension: dim,
      action: 'Fix the malformed JSON-LD block(s) so they parse as valid JSON',
      why: 'A block that fails JSON.parse is silently ignored by every consumer; it contributes nothing while still costing bytes.',
      impact: 2,
      effort: 1,
    });
  }

  // Article / BlogPosting with author + dates
  const articleNode = nodes.find((n) => {
    const t = jsonLdTypes([n]);
    return t.includes('article') || t.includes('blogposting') || t.includes('newsarticle') || t.includes('techarticle');
  });
  if (articleNode) {
    score += 20;
    evidence.push({ status: 'pass', message: `Article/BlogPosting schema present` });
    if (articleNode['author']) {
      score += 10;
      evidence.push({ status: 'pass', message: 'Article has an author property' });
    } else {
      evidence.push({ status: 'warn', message: 'Article schema lacks an author property' });
      recommendations.push({
        dimension: dim,
        action: 'Add an author (Person) to the Article schema',
        why: 'Author attribution is an E-E-A-T signal Google uses for AI Overview source selection; an authorless article reads as anonymous content.',
        impact: 2,
        effort: 1,
      });
    }
    if (articleNode['datePublished'] || articleNode['dateModified']) {
      score += 10;
      evidence.push({
        status: 'pass',
        message: `Article has dates (datePublished: ${String(articleNode['datePublished'] ?? 'unset')}, dateModified: ${String(articleNode['dateModified'] ?? 'unset')})`,
      });
    } else {
      evidence.push({ status: 'warn', message: 'Article schema lacks datePublished/dateModified' });
    }
  } else if (blockCount > 0) {
    evidence.push({ status: 'warn', message: 'no Article/BlogPosting schema found' });
  }

  if (has('FAQPage')) {
    score += 15;
    evidence.push({ status: 'pass', message: 'FAQPage schema present' });
  } else {
    evidence.push({ status: 'info', message: 'no FAQPage schema' });
  }
  if (has('Organization')) {
    score += 15;
    evidence.push({ status: 'pass', message: 'Organization schema present' });
  } else {
    evidence.push({ status: 'warn', message: 'no Organization schema; weakens entity resolution' });
    recommendations.push({
      dimension: dim,
      action: 'Add Organization JSON-LD (name, url, logo, sameAs) on the homepage',
      why: 'Organization markup anchors the brand as a knowledge-graph entity, which is how Google-side AI features decide the content has an accountable source. Other engines infer the entity from text, so keep the org name consistent in prose too.',
      impact: 2,
      effort: 1,
    });
  }
  if (has('Person')) {
    score += 5;
    evidence.push({ status: 'pass', message: 'Person schema present' });
  }
  if (has('BreadcrumbList')) {
    score += 5;
    evidence.push({ status: 'pass', message: 'BreadcrumbList schema present' });
  }

  const otherTypes = [...new Set(types)].join(', ');
  if (otherTypes) evidence.push({ status: 'info', message: `all @type values seen: ${otherTypes}` });
  evidence.push({
    status: 'info',
    message: 'weighting note: structured data mainly moves Google AI Overviews + entity trust; ChatGPT/Claude/Perplexity largely tokenize text rather than parse the graph. GEO-16 (2025) found it correlates with observed citations across engines, but correlation ≠ causation, so the weight stays medium',
  });

  return {
    key: 'structuredData',
    name: dim,
    weight: 2,
    score: Math.max(0, Math.min(100, Math.round(score))),
    evidence,
    recommendations,
  };
}
