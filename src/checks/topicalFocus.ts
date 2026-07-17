import type { AuditContext } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { extractHeadings, extractTitle, extractVisibleText, findMeta, mainContentHtml, wordCount } from '../html.js';

/**
 * Topical focus & metadata. The 2025-2026 replication work reordered what
 * matters: in the largest controlled study to date (Vishwakarma et al.,
 * "What Gets Cited", SIGIR 2026 — 252,000 trials across six LLMs), topical
 * relevance and context position dominated citation choice, ahead of every
 * content rewrite tested. Position is the retriever's call; relevance is the
 * page's. A single audited URL has no target query, so this check measures the
 * page-side proxy: whether the title, H1, description and body legibly present
 * ONE topic a retriever can match a query against. GEO-16 (Kumar & Palkhouski
 * 2025) independently found metadata quality among the strongest correlates of
 * real citations on Brave, Google AI Overviews and Perplexity.
 */

const STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'whose', 'does', 'will', 'your', 'with', 'from', 'this', 'that',
  'should', 'have', 'been', 'they', 'them', 'their', 'there', 'here', 'into', 'about', 'more', 'most',
  'some', 'other', 'than', 'then', 'only', 'also', 'over', 'such', 'very', 'just', 'like', 'make',
  'made', 'take', 'used', 'using', 'each', 'both', 'many', 'much', 'well', 'even', 'still', 'after',
  'before', 'under', 'while', 'these', 'those', 'guide', 'complete', 'ultimate', 'best',
]);

/** Content-bearing words: ≥4 chars, not a stopword. */
function contentWords(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  )];
}

/**
 * The topic segment of a <title>: titles are commonly "Topic | Brand" or
 * "Brand | Topic"; the longer segment is almost always the topic.
 */
function titleTopicSegment(title: string): string {
  const parts = title.split(/\s*[|·—–]\s*| - /).filter((p) => p.trim().length > 0);
  if (parts.length === 0) return title;
  return parts.reduce((a, b) => (b.length > a.length ? b : a));
}

export function checkTopicalFocus(ctx: AuditContext): DimensionResult {
  const dim = 'Topical focus & metadata';
  const html = ctx.target?.html ?? null;
  if (html === null) {
    return {
      key: 'topicalFocus',
      name: dim,
      weight: 3,
      score: null,
      evidence: [{ status: 'unverified', message: 'could not verify: page HTML unavailable' }],
      recommendations: [],
    };
  }

  const evidence: Evidence[] = [];
  const recommendations: Recommendation[] = [];
  let score = 0;

  // 1. <title> present and informative (0-20)
  const title = extractTitle(html);
  if (title === null || title.length === 0) {
    evidence.push({ status: 'fail', message: 'no <title> tag found' });
    recommendations.push({
      dimension: dim,
      action: 'Write a descriptive <title> that names the exact topic the page answers',
      why: 'The title is the first surface retrieval systems match a query against. In the largest controlled citation study to date (Vishwakarma et al., SIGIR 2026; 252,000 trials, six LLMs), topical relevance was the strongest page-side driver of which source gets cited.',
      impact: 3,
      effort: 1,
    });
  } else if (title.length >= 15 && title.length <= 70) {
    score += 20;
    evidence.push({ status: 'pass', message: `title present, informative length: "${title.slice(0, 80)}" (${title.length} chars)` });
  } else {
    score += 10;
    evidence.push({ status: 'warn', message: `title present but ${title.length < 15 ? 'very short' : 'long'} (${title.length} chars): "${title.slice(0, 80)}"` });
    recommendations.push({
      dimension: dim,
      action: 'Rewrite the <title> to a 15-70 character statement of the page topic',
      why: 'A title too short to name the topic (or long enough to bury it) weakens the query-to-page relevance match that controlled studies (Vishwakarma et al., SIGIR 2026) identify as the top citation driver.',
      impact: 2,
      effort: 1,
    });
  }

  // 2. Meta description (0-15)
  const description = findMeta(html, 'description');
  if (!description) {
    evidence.push({ status: 'fail', message: 'no meta description found' });
    recommendations.push({
      dimension: dim,
      action: 'Add a meta description that summarizes the page topic in 50-170 characters',
      why: 'Metadata quality was among the strongest correlates of real citations across Brave, Google AI Overviews and Perplexity in the GEO-16 empirical study (Kumar & Palkhouski 2025; 1,702 citations audited). The description is also the snippet many engines feed their retriever.',
      impact: 2,
      effort: 1,
    });
  } else if (description.length >= 50 && description.length <= 170) {
    score += 15;
    evidence.push({ status: 'pass', message: `meta description present, good length (${description.length} chars)` });
  } else {
    score += 8;
    evidence.push({ status: 'warn', message: `meta description present but ${description.length < 50 ? 'short' : 'long'} (${description.length} chars)` });
  }

  // 3. Title ↔ H1 topic agreement (0-20)
  const h1s = extractHeadings(html).filter((h) => h.level === 1);
  const h1 = h1s[0]?.text ?? null;
  const topicSource = h1 ?? (title ? titleTopicSegment(title) : null);
  if (title && h1) {
    const titleWords = contentWords(titleTopicSegment(title));
    const h1Words = contentWords(h1);
    const shared = h1Words.filter((w) => titleWords.includes(w));
    const denom = Math.min(titleWords.length, h1Words.length);
    const ratio = denom > 0 ? shared.length / denom : 0;
    if (ratio >= 0.5) {
      score += 20;
      evidence.push({ status: 'pass', message: `title and H1 agree on the topic (shared terms: ${shared.slice(0, 5).join(', ') || 'n/a'})` });
    } else if (ratio > 0) {
      score += 12;
      evidence.push({ status: 'warn', message: `title and H1 only partially overlap (shared: ${shared.join(', ')})` });
    } else {
      evidence.push({ status: 'fail', message: `title ("${titleTopicSegment(title).slice(0, 50)}") and H1 ("${h1.slice(0, 50)}") share no content words; the page signals two different topics` });
      recommendations.push({
        dimension: dim,
        action: 'Align the H1 and <title> so both name the same topic',
        why: 'A retriever scoring query relevance sees the title; the generator sees the H1 atop the extracted text. When they disagree, at least one surface mismatches every query, and relevance is the top controllable citation driver (Vishwakarma et al., SIGIR 2026).',
        impact: 2,
        effort: 1,
      });
    }
  } else {
    evidence.push({ status: 'warn', message: `cannot compare title and H1 (${title ? 'no H1 found' : 'no title found'}); topic agreement unscored` });
  }

  // 4. Topic-term echo in the body (0-30): does the body actually cover the
  // topic the H1/title promises? Terms are matched by 6-char prefix so
  // "optimization" also credits "optimizing".
  const mainText = extractVisibleText(mainContentHtml(html));
  const bodyWords = wordCount(mainText);
  if (bodyWords < 15) {
    evidence.push({ status: 'fail', message: `no extractable main content to measure topical coverage against (${bodyWords} words)` });
    recommendations.push({
      dimension: dim,
      action: 'Get real text into this page first (see Renderability), or run the audit against the page that actually carries your content',
      why: 'Topical relevance is the top controllable citation driver (Vishwakarma et al., SIGIR 2026), and it is computed over extractable text; a page without text cannot be relevant to anything.',
      impact: 3,
      effort: 1,
    });
  } else if (topicSource) {
    const terms = contentWords(topicSource).slice(0, 8);
    if (terms.length === 0) {
      evidence.push({ status: 'warn', message: 'H1/title carry no content-bearing terms to check the body against' });
    } else {
      const lower = mainText.toLowerCase();
      const echoed = terms.filter((t) => {
        const prefix = t.slice(0, 6).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return (lower.match(new RegExp(`(?<![\\p{L}\\p{N}])${prefix}`, 'gu')) ?? []).length >= 2;
      });
      const share = echoed.length / terms.length;
      if (share >= 0.6) {
        score += 30;
        evidence.push({ status: 'pass', message: `body consistently covers the stated topic (${echoed.length}/${terms.length} topic terms recur: ${echoed.slice(0, 6).join(', ')})` });
      } else if (share >= 0.3) {
        score += 18;
        evidence.push({ status: 'warn', message: `body partially covers the stated topic (${echoed.length}/${terms.length} topic terms recur)` });
      } else {
        score += share > 0 ? 8 : 0;
        evidence.push({ status: 'fail', message: `body rarely mentions the topic the H1/title promise (${echoed.length}/${terms.length} topic terms recur)` });
        recommendations.push({
          dimension: dim,
          action: 'Make the body substantively cover the topic named in the H1 and title (or retitle the page to what it actually covers)',
          why: 'Retrievers score chunk-to-query relevance over the body text; a page whose body drifts from its own stated topic loses the relevance match that controlled studies (Vishwakarma et al., SIGIR 2026) found dominates citation choice.',
          impact: 3,
          effort: 2,
        });
      }
    }
  } else {
    evidence.push({ status: 'fail', message: 'no title or H1 to derive a topic from; topical coverage unscorable' });
  }

  // 5. Canonical URL (0-5)
  if (/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i.test(html)) {
    score += 5;
    evidence.push({ status: 'pass', message: 'canonical link present' });
  } else {
    evidence.push({ status: 'info', message: 'no canonical link; duplicate URLs may split the page\'s retrieval identity' });
  }

  // 6. Open Graph title/description (0-10)
  const ogTitle = findMeta(html, 'og:title');
  const ogDesc = findMeta(html, 'og:description');
  if (ogTitle && ogDesc) {
    score += 10;
    evidence.push({ status: 'pass', message: 'og:title and og:description present' });
  } else if (ogTitle || ogDesc) {
    score += 5;
    evidence.push({ status: 'warn', message: `only ${ogTitle ? 'og:title' : 'og:description'} present` });
  } else {
    evidence.push({ status: 'warn', message: 'no Open Graph title/description; some crawl pipelines read these as the page summary' });
  }

  evidence.push({
    status: 'info',
    message: 'limitation: with no target query, this measures topical legibility (one coherent, consistently-stated topic), not relevance to any specific query; retrieval position (the other dominant factor in the 2026 studies) is not page-controllable and is not scored',
  });

  return {
    key: 'topicalFocus',
    name: dim,
    weight: 3,
    score: Math.max(0, Math.min(100, Math.round(score))),
    evidence,
    recommendations,
  };
}
