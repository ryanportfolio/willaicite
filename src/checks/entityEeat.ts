import type { AuditContext } from '../context.js';
import type { DimensionResult, Evidence, Recommendation } from '../types.js';
import { extractJsonLd, extractLinks, extractTitle, extractVisibleText, findMeta, jsonLdTypes } from '../html.js';

/**
 * Entity & E-E-A-T: can an engine tell WHO is behind this content and resolve
 * the site to a consistent entity? Bylines, about page, org-name consistency,
 * contact info, favicon + OG metadata.
 */
export function checkEntityEeat(ctx: AuditContext): DimensionResult {
  const dim = 'Entity & E-E-A-T';
  const html = ctx.target?.html ?? null;
  if (html === null) {
    return {
      key: 'entityEeat',
      name: dim,
      weight: 2,
      score: null,
      evidence: [{ status: 'unverified', message: 'could not verify: page HTML unavailable' }],
      recommendations: [],
    };
  }

  const evidence: Evidence[] = [];
  const recommendations: Recommendation[] = [];
  let score = 0;
  const pages = [ctx.target, ctx.homepage].filter((p): p is NonNullable<typeof p> => Boolean(p?.html));

  // 1. Author byline (0-20)
  const byline = findByline(html);
  if (byline) {
    score += 20;
    evidence.push({ status: 'pass', message: `author byline found: ${byline}` });
  } else {
    evidence.push({ status: 'fail', message: 'no author byline detected (no JSON-LD author, meta author, or visible "By <name>" pattern)' });
    recommendations.push({
      dimension: dim,
      action: 'Add a visible author byline with a real name (plus author in Article JSON-LD)',
      why: 'E-E-A-T source selection favors accountable authorship; engines preferring citable sources treat anonymous content as lower-trust, and Google documents authorship as an AI Overview quality input.',
      impact: 2,
      effort: 1,
    });
  }

  // 2. About page (0-20)
  if (ctx.aboutPage && ctx.aboutPage.fetch.status === 200) {
    score += 20;
    evidence.push({ status: 'pass', message: `about page exists (${ctx.aboutPage.url} → HTTP 200)` });
  } else if (ctx.aboutPage && ctx.aboutPage.fetch.status !== null) {
    evidence.push({ status: 'fail', message: `no about page found (${ctx.aboutPage.url} → HTTP ${ctx.aboutPage.fetch.status})` });
    recommendations.push({
      dimension: dim,
      action: 'Publish an /about page describing who runs the site and their credentials',
      why: 'The about page is the canonical place engines (and Google raters) look to resolve "who is behind this"; its absence leaves the entity unresolvable.',
      impact: 2,
      effort: 2,
    });
  } else {
    evidence.push({ status: 'unverified', message: 'could not verify about page (fetch failed or skipped)' });
  }

  // 3. Org name consistency (0-20)
  const names = orgNameCandidates(pages.map((p) => p.html!));
  const distinct = [...new Set(names.map((n) => n.value.toLowerCase().trim()))];
  const counts = new Map<string, number>();
  for (const n of names) {
    const k = n.value.toLowerCase().trim();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const agreeing = [...counts.values()].some((c) => c >= 2);
  if (names.length === 0) {
    evidence.push({ status: 'fail', message: 'no organization name found in title, og:site_name, or Organization schema' });
  } else if (agreeing || distinct.length === 1) {
    score += 20;
    evidence.push({
      status: 'pass',
      message: `org name consistent across sources: ${names.map((n) => `${n.source}="${n.value}"`).join(', ')}`,
    });
  } else {
    score += 10;
    evidence.push({
      status: 'warn',
      message: `org name sources disagree: ${names.map((n) => `${n.source}="${n.value}"`).join(', ')}`,
    });
    recommendations.push({
      dimension: dim,
      action: 'Use one canonical organization name across <title>, og:site_name, Organization schema and the footer',
      why: 'Entity resolution is string-matching plus graph signals; inconsistent naming splits the entity across variants and dilutes every trust signal attached to it.',
      impact: 1,
      effort: 1,
    });
  }

  // 4. Contact info (0-15)
  const contact = findContact(pages.map((p) => p.html!));
  if (contact) {
    score += 15;
    evidence.push({ status: 'pass', message: `contact info found: ${contact}` });
  } else {
    evidence.push({ status: 'warn', message: 'no contact info detected (no mailto:, tel:, or /contact link)' });
    recommendations.push({
      dimension: dim,
      action: 'Add a reachable contact route (contact page link, mailto:, or phone)',
      why: 'Contactability is a baseline accountability signal in E-E-A-T assessment; unreachable publishers score as lower-trust sources.',
      impact: 1,
      effort: 1,
    });
  }

  // 5. Favicon (0-10)
  const faviconLink = /<link\b[^>]*rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/i.test(html);
  if (faviconLink || ctx.faviconStatus === 200) {
    score += 10;
    evidence.push({ status: 'pass', message: faviconLink ? 'favicon declared via <link rel=icon>' : 'favicon.ico responds with HTTP 200' });
  } else if (ctx.faviconStatus !== null) {
    evidence.push({ status: 'warn', message: `no favicon (<link rel=icon> absent, /favicon.ico → HTTP ${ctx.faviconStatus})` });
  } else {
    evidence.push({ status: 'unverified', message: 'could not verify favicon' });
  }

  // 6. OG metadata (0-15)
  const ogTitle = findMeta(html, 'og:title');
  const ogDesc = findMeta(html, 'og:description');
  const ogImage = findMeta(html, 'og:image');
  if (ogTitle && ogDesc) {
    score += 10;
    evidence.push({ status: 'pass', message: 'og:title and og:description present' });
  } else {
    evidence.push({ status: 'warn', message: `Open Graph metadata incomplete (og:title ${ogTitle ? '✓' : '✗'}, og:description ${ogDesc ? '✓' : '✗'})` });
    recommendations.push({
      dimension: dim,
      action: 'Add og:title, og:description and og:image metadata',
      why: 'OG tags are the canonical machine-readable summary of the page; answer engines and link-preview pipelines use them for titling and snippet fallback.',
      impact: 1,
      effort: 1,
    });
  }
  if (ogImage) {
    score += 5;
    evidence.push({ status: 'pass', message: 'og:image present' });
  }

  return { key: 'entityEeat', name: dim, weight: 2, score: Math.max(0, Math.min(100, Math.round(score))), evidence, recommendations };
}

function findByline(html: string): string | null {
  const { nodes } = extractJsonLd(html);
  for (const node of nodes) {
    const author = node['author'];
    const name = authorName(author);
    if (name) return `JSON-LD author "${name}"`;
  }
  const metaAuthor = findMeta(html, 'author');
  if (metaAuthor) return `meta author "${metaAuthor}"`;
  const text = extractVisibleText(html).slice(0, 3000);
  const m = text.match(/\b[Bb]y\s+([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,2})\b/);
  if (m) return `visible byline "By ${m[1]}"`;
  if (/class\s*=\s*["'][^"']*\bauthor\b/i.test(html)) return 'author-classed element in markup';
  return null;
}

function authorName(author: unknown): string | null {
  if (typeof author === 'string') return author;
  if (Array.isArray(author)) {
    for (const a of author) {
      const n = authorName(a);
      if (n) return n;
    }
    return null;
  }
  if (author && typeof author === 'object') {
    const n = (author as Record<string, unknown>)['name'];
    if (typeof n === 'string') return n;
  }
  return null;
}

interface NameCandidate {
  source: string;
  value: string;
}

function orgNameCandidates(htmls: string[]): NameCandidate[] {
  const out: NameCandidate[] = [];
  const seenSources = new Set<string>();
  const titleSegments: string[] = [];

  for (const html of htmls) {
    if (titleSegments.length === 0) {
      const title = extractTitle(html);
      if (title) {
        for (const seg of title.split(/\s+[|·–—-]\s+/)) {
          const t = seg.trim();
          if (t.length >= 2 && t.length <= 60) titleSegments.push(t);
        }
      }
    }
    const siteName = findMeta(html, 'og:site_name');
    if (siteName && !seenSources.has('og')) {
      out.push({ source: 'og:site_name', value: siteName });
      seenSources.add('og');
    }
    const { nodes } = extractJsonLd(html);
    for (const node of nodes) {
      if (jsonLdTypes([node]).includes('organization') || jsonLdTypes([node]).includes('website')) {
        const name = node['name'];
        if (typeof name === 'string' && !seenSources.has('schema')) {
          out.push({ source: `${jsonLdTypes([node]).includes('organization') ? 'Organization' : 'WebSite'} schema`, value: name });
          seenSources.add('schema');
        }
      }
    }
  }

  // The brand can sit at either end of the title ("Brand | Page" or
  // "Page | Brand"). Prefer whichever segment matches another source; only
  // fall back to the suffix convention when nothing else corroborates.
  if (titleSegments.length > 0) {
    const others = out.map((n) => n.value.toLowerCase().trim());
    const matching = titleSegments.find((seg) => others.includes(seg.toLowerCase().trim()));
    if (matching) out.push({ source: 'title', value: matching });
    else out.push({ source: 'title suffix', value: titleSegments[titleSegments.length - 1] });
  }
  return out;
}

function findContact(htmls: string[]): string | null {
  for (const html of htmls) {
    const links = extractLinks(html);
    const mailto = links.find((l) => l.href.toLowerCase().startsWith('mailto:'));
    if (mailto) return `mailto link (${mailto.href})`;
    const tel = links.find((l) => l.href.toLowerCase().startsWith('tel:'));
    if (tel) return `tel link (${tel.href})`;
    const contactLink = links.find((l) => /contact/i.test(l.href) || /contact/i.test(l.text));
    if (contactLink) return `contact link (${contactLink.href})`;
  }
  return null;
}
