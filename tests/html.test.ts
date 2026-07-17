import { describe, it, expect } from 'vitest';
import {
  extractVisibleText,
  extractTitle,
  extractHeadings,
  extractJsonLd,
  jsonLdTypes,
  extractLinks,
  detectEmptyShell,
  mainContentHtml,
  findMeta,
  noscriptText,
  decodeEntities,
  countTag,
} from '../src/html.js';
import { fixture } from './helpers.js';

const article = fixture('article-good.html');
const spa = fixture('spa-shell.html');

describe('extractVisibleText', () => {
  it('strips scripts, styles, head, and tags', () => {
    const text = extractVisibleText(spa);
    expect(text).not.toContain('__PRELOAD__');
    expect(text).not.toContain('margin');
    expect(text).not.toContain('Acme App'); // title is in head
    expect(text).not.toContain('enable JavaScript'); // noscript stripped
  });

  it('decodes entities and collapses whitespace', () => {
    expect(extractVisibleText('<p>a&amp;b   \n c&#65;</p>')).toBe('a&b cA');
  });
});

describe('decodeEntities', () => {
  it('handles named, decimal, and hex entities', () => {
    expect(decodeEntities('&lt;&#62;&#x26;&rsquo;')).toBe('<>&’');
  });
});

describe('extractTitle / findMeta', () => {
  it('extracts title and og meta', () => {
    expect(extractTitle(article)).toBe('What Is Generative Engine Optimization? | Acme Research');
    expect(findMeta(article, 'og:site_name')).toBe('Acme Research');
    expect(findMeta(article, 'article:modified_time')).toBe('2026-06-20T09:00:00Z');
    expect(findMeta(article, 'missing')).toBeNull();
  });
});

describe('extractHeadings', () => {
  it('returns levels and text in order', () => {
    const hs = extractHeadings(article);
    expect(hs[0]).toEqual({ level: 1, text: 'What Is Generative Engine Optimization?' });
    expect(hs.filter((h) => h.level === 2)).toHaveLength(4);
  });
});

describe('mainContentHtml chrome stripping', () => {
  it('strips nav/footer/header/aside in the body fallback (no <main>/<article>)', () => {
    const html =
      '<html><body><header><a href="/">Home</a></header><nav><ul><li><a href="/x">X</a></li></ul></nav>' +
      '<p>Real content sentence that carries the substance of the page for readers today.</p>' +
      '<footer><a href="https://twitter.com/acme">Twitter</a> © 2026</footer></body></html>';
    const main = mainContentHtml(html);
    expect(main).toContain('Real content sentence');
    expect(main).not.toContain('twitter.com');
    expect(main).not.toContain('<nav');
  });

  it('trusts an explicit <main> as-is', () => {
    const html =
      '<html><body><main><header><h1>Article header inside main stays</h1></header>' +
      '<p>Long enough main content that clears the eighty character floor for the region.</p></main></body></html>';
    expect(mainContentHtml(html)).toContain('Article header inside main stays');
  });

  it('does not trust a <main> that only exists inside a <template>', () => {
    const html =
      '<html><body><template><main>Template-only content that renders nothing but is long enough to pass the floor easily.</main></template>' +
      '<p>Actual visible fallback content with enough words to stand in as the page body for checks.</p></body></html>';
    const main = mainContentHtml(html);
    expect(main).not.toContain('Template-only content');
    expect(main).toContain('Actual visible fallback content');
  });

  it('does not trust a <main> that only exists inside an HTML comment', () => {
    const html =
      '<html><body><!-- <main>Commented-out content that renders nothing but is long enough to pass the floor easily.</main> -->' +
      '<p>Actual visible fallback content with enough words to stand in as the page body for checks.</p></body></html>';
    const main = mainContentHtml(html);
    expect(main).not.toContain('Commented-out content');
    expect(main).toContain('Actual visible fallback content');
  });
});

describe('extractJsonLd', () => {
  it('flattens @graph into nodes', () => {
    const { nodes, errors, blockCount } = extractJsonLd(article);
    expect(blockCount).toBe(1);
    expect(errors).toHaveLength(0);
    const types = jsonLdTypes(nodes);
    expect(types).toContain('article');
    expect(types).toContain('organization');
    expect(types).toContain('faqpage');
  });

  it('collects parse errors without throwing', () => {
    const html = '<script type="application/ld+json">{not json}</script>';
    const { nodes, errors } = extractJsonLd(html);
    expect(nodes).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('handles top-level arrays and array @type', () => {
    const html = '<script type="application/ld+json">[{"@type": ["Article", "TechArticle"]}]</script>';
    const { nodes } = extractJsonLd(html);
    expect(jsonLdTypes(nodes)).toEqual(['article', 'techarticle']);
  });
});

describe('extractLinks', () => {
  it('returns hrefs and text', () => {
    const links = extractLinks(article);
    const arxiv = links.find((l) => l.href.includes('arxiv.org'));
    expect(arxiv?.text).toBe('arXiv');
  });
});

describe('detectEmptyShell', () => {
  it('detects an empty #root SPA shell', () => {
    expect(detectEmptyShell(spa)).toBe('#root');
  });

  it('detects a Nuxt (__nuxt) mount point', () => {
    expect(detectEmptyShell('<body><div id="__nuxt"></div><script src="/app.js"></script></body>')).toBe('#__nuxt');
  });

  it('does not flag a content-rich page with a root div', () => {
    const html = `<body><div id="root"><p>${'word '.repeat(200)}</p></div></body>`;
    expect(detectEmptyShell(html)).toBeNull();
  });
});

describe('mainContentHtml', () => {
  it('prefers <main> when substantive', () => {
    const main = mainContentHtml(article);
    expect(main).toContain('Generative Engine Optimization (GEO) is');
    expect(main).not.toContain('footer');
  });

  it('falls back to body when no main/article', () => {
    const html = '<html><body><p>hello world content here</p></body></html>';
    expect(mainContentHtml(html)).toContain('hello world');
  });
});

describe('noscriptText / countTag', () => {
  it('extracts noscript text', () => {
    expect(noscriptText(spa)).toContain('enable JavaScript');
  });

  it('counts tags outside stripped regions', () => {
    expect(countTag(article, 'table')).toBe(1);
    expect(countTag(article, 'blockquote')).toBe(1);
  });
});
