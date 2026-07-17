/**
 * Lightweight, dependency-free HTML extraction helpers.
 *
 * These are deliberately regex-based heuristics operating on raw HTML with no
 * JS execution and no full DOM — good enough for audit signals, not a parser.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
  times: '×',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/** Remove comments and non-visible element subtrees (script, style, noscript, template, svg, iframe). */
export function stripInvisible(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
}

/** Visible text extractable from raw HTML without JS execution. */
export function extractVisibleText(html: string): string {
  const withoutHead = html.replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ');
  const stripped = stripInvisible(withoutHead)
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

export function extractTitle(html: string): string | null {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : null;
}

export function getAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
}

export interface MetaTag {
  name: string | null;
  property: string | null;
  httpEquiv: string | null;
  content: string | null;
}

export function extractMetaTags(html: string): MetaTag[] {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  return tags.map((tag) => ({
    name: getAttr(tag, 'name')?.toLowerCase() ?? null,
    property: getAttr(tag, 'property')?.toLowerCase() ?? null,
    httpEquiv: getAttr(tag, 'http-equiv')?.toLowerCase() ?? null,
    content: getAttr(tag, 'content'),
  }));
}

export function findMeta(html: string, key: string): string | null {
  const k = key.toLowerCase();
  for (const m of extractMetaTags(html)) {
    if (m.name === k || m.property === k) return m.content;
  }
  return null;
}

export interface Heading {
  level: number;
  text: string;
}

export function extractHeadings(html: string): Heading[] {
  const out: Heading[] = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m: RegExpExecArray | null;
  const cleaned = stripInvisible(html);
  while ((m = re.exec(cleaned)) !== null) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text) out.push({ level: Number(m[1]), text });
  }
  return out;
}

export interface JsonLdExtraction {
  /** Every top-level node, with `@graph` arrays flattened. */
  nodes: Record<string, unknown>[];
  /** Snippets of blocks that failed to parse. */
  errors: string[];
  blockCount: number;
}

export function extractJsonLd(html: string): JsonLdExtraction {
  const nodes: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let blockCount = 0;
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blockCount++;
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          const graph = obj['@graph'];
          if (Array.isArray(graph)) {
            for (const g of graph) {
              if (g && typeof g === 'object') nodes.push(g as Record<string, unknown>);
            }
          } else {
            nodes.push(obj);
          }
        }
      }
    } catch {
      errors.push(raw.slice(0, 120));
    }
  }
  return { nodes, errors, blockCount };
}

/** All `@type` values (lowercased) across JSON-LD nodes, including array types. */
export function jsonLdTypes(nodes: Record<string, unknown>[]): string[] {
  const types: string[] = [];
  for (const node of nodes) {
    const t = node['@type'];
    if (typeof t === 'string') types.push(t.toLowerCase());
    else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') types.push(x.toLowerCase());
  }
  return types;
}

export interface LinkTag {
  href: string;
  text: string;
  rel: string | null;
}

export function extractLinks(html: string): LinkTag[] {
  const out: LinkTag[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  const cleaned = stripInvisible(html);
  while ((m = re.exec(cleaned)) !== null) {
    const href = getAttr(`<a ${m[1]}>`, 'href');
    if (!href) continue;
    out.push({
      href,
      text: decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
      rel: getAttr(`<a ${m[1]}>`, 'rel'),
    });
  }
  return out;
}

export function countTag(html: string, tag: string): number {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  return (stripInvisible(html).match(re) ?? []).length;
}

/** Inner HTML of the first matching tag, or null. */
export function extractInner(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

/** Remove page-chrome subtrees (nav, footer, header, aside) from a fragment. */
export function stripChrome(html: string): string {
  return html.replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1\s*>/gi, ' ');
}

/**
 * Best-effort main content region: <main>, then <article>, then <body>, then
 * the whole document. The body/document fallbacks strip page chrome
 * (nav/footer/header/aside) so boilerplate links and lists don't masquerade
 * as main-content signals; an explicit <main>/<article> is trusted as-is.
 */
export function mainContentHtml(html: string): string {
  const main = extractInner(html, 'main');
  if (main && extractVisibleText(main).length > 80) return main;
  const article = extractInner(html, 'article');
  if (article && extractVisibleText(article).length > 80) return article;
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
  if (body) return stripChrome(body[1]);
  return stripChrome(html);
}

const SHELL_IDS = ['root', 'app', '__next', '___gatsby', 'q-app', 'svelte'];

/**
 * Detect an SPA shell: a mount-point element (<div id="root"> etc. or
 * <app-root>) whose static subtree carries almost no visible text while the
 * page as a whole also carries almost no visible text.
 */
export function detectEmptyShell(html: string): string | null {
  const bodyText = extractVisibleText(html);
  if (bodyText.length > 400) return null;
  for (const id of SHELL_IDS) {
    const re = new RegExp(`<(div|main|section)\\b[^>]*id\\s*=\\s*["']?${id}["']?[^>]*>`, 'i');
    if (re.test(html)) return `#${id}`;
  }
  if (/<app-root\b[^>]*>\s*<\/app-root>/i.test(html)) return 'app-root';
  return null;
}

export function noscriptText(html: string): string {
  const m = html.match(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/i);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function firstWords(text: string, n: number): string {
  return text.split(/\s+/).filter(Boolean).slice(0, n).join(' ');
}
