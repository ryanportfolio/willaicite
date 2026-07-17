import { describe, it, expect } from 'vitest';
import { checkCrawlerAccess } from '../src/checks/crawlerAccess.js';
import { checkRenderability } from '../src/checks/renderability.js';
import { checkStructuredData } from '../src/checks/structuredData.js';
import { checkAnswerReadiness } from '../src/checks/answerReadiness.js';
import { checkTopicalFocus } from '../src/checks/topicalFocus.js';
import { checkEvidenceDensity } from '../src/checks/evidenceDensity.js';
import { checkFreshness } from '../src/checks/freshness.js';
import { checkEntityEeat } from '../src/checks/entityEeat.js';
import { checkLlmsTxt } from '../src/checks/llmsTxt.js';
import { makeCtx, makePage, makeFetch, fixture, robotsCtxFrom, NOW } from './helpers.js';
import { parseRobots } from '../src/robots.js';

describe('checkCrawlerAccess', () => {
  it('scores 100 when nothing blocks (no robots.txt, clean headers, same status both UAs)', () => {
    const r = checkCrawlerAccess(makeCtx());
    expect(r.score).toBe(100);
    expect(r.evidence.some((e) => e.message.includes('all crawlers allowed by default'))).toBe(true);
  });

  it('deducts per blocked bot (tiered by role) and cites the exact robots.txt line', () => {
    const r = checkCrawlerAccess(makeCtx({ robots: robotsCtxFrom('robots-blocking.txt') }));
    // Claude-SearchBot (retrieval, −14) + GPTBot, ClaudeBot (training, −4 each)
    expect(r.score).toBe(100 - 14 - 4 - 4);
    const searchbot = r.evidence.find((e) => e.message.startsWith('Claude-SearchBot BLOCKED'));
    expect(searchbot?.status).toBe('fail');
    const gptbot = r.evidence.find((e) => e.message.startsWith('GPTBot BLOCKED'));
    expect(gptbot?.status).toBe('warn'); // training-only block = policy warning, not a citation failure
    expect(gptbot?.message).toContain('line 5');
    expect(gptbot?.message).toContain('Disallow: /');
    expect(r.recommendations.some((rec) => rec.action.includes('Unblock Claude-SearchBot'))).toBe(true);
    expect(r.recommendations.some((rec) => rec.action.includes('Confirm blocking GPTBot, ClaudeBot'))).toBe(true);
  });

  it('summarizes allowed bots by tier instead of one line per bot', () => {
    const r = checkCrawlerAccess(makeCtx({ robots: robotsCtxFrom('robots-blocking.txt') }));
    expect(r.evidence.some((e) => e.status === 'pass' && e.message.includes('retrieval/citation crawler(s) allowed'))).toBe(true);
    expect(r.evidence.some((e) => e.status === 'pass' && e.message.includes('training crawler(s)/opt-out token(s) allowed'))).toBe(true);
  });

  it('scores a Perplexity-User disallow as a light advisory, not a hard retrieval block', () => {
    const body = 'User-agent: Perplexity-User\nDisallow: /\n';
    const r = checkCrawlerAccess(
      makeCtx({
        robots: { url: 'https://example.com/robots.txt', fetch: makeFetch({ body }), parsed: parseRobots(body) },
      }),
    );
    expect(r.score).toBe(98); // ADVISORY_PENALTY, not the 14-point retrieval penalty
    const ev = r.evidence.find((e) => e.message.startsWith('Perplexity-User'));
    expect(ev?.status).toBe('warn');
    expect(ev?.message).toContain('ignore robots.txt');
    expect(r.recommendations.some((rec) => rec.action.includes('Unblock'))).toBe(false);
    expect(r.recommendations.some((rec) => rec.action.includes('enforce it at the WAF/CDN'))).toBe(true);
  });

  it('flags the Gemini grounding cost when Google-Extended is blocked', () => {
    const body = 'User-agent: Google-Extended\nDisallow: /\n';
    const r = checkCrawlerAccess(
      makeCtx({
        robots: { url: 'https://example.com/robots.txt', fetch: makeFetch({ body }), parsed: parseRobots(body) },
      }),
    );
    expect(r.score).toBe(96); // training-tier penalty
    const ev = r.evidence.find((e) => e.message.startsWith('Google-Extended'));
    expect(ev?.message).toContain('Gemini grounding');
    const rec = r.recommendations.find((rec) => rec.action.includes('Google-Extended'));
    expect(rec?.why).toContain('Gemini citations of this content do stop');
  });

  it('surfaces a Content Signals policy line as informational evidence', () => {
    const body = 'Content-Signal: search=yes, ai-train=no\nUser-agent: *\nDisallow:\n';
    const r = checkCrawlerAccess(
      makeCtx({
        robots: { url: 'https://example.com/robots.txt', fetch: makeFetch({ body }), parsed: parseRobots(body) },
      }),
    );
    expect(r.evidence.some((e) => e.status === 'info' && e.message.includes('Content Signals'))).toBe(true);
  });

  it('flags meta robots noindex', () => {
    const html = '<html><head><meta name="robots" content="noindex, nofollow"></head><body><p>hi</p></body></html>';
    const r = checkCrawlerAccess(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.score).toBe(70);
    expect(r.evidence.some((e) => e.status === 'fail' && e.message.includes('noindex'))).toBe(true);
  });

  it('flags X-Robots-Tag noindex from headers', () => {
    const ctx = makeCtx();
    ctx.target!.fetch.headers['x-robots-tag'] = 'noindex';
    const r = checkCrawlerAccess(ctx);
    expect(r.score).toBe(70);
  });

  it('flags a UA differential (WAF blocking bot UA)', () => {
    const ctx = makeCtx({ targetBotFetch: makeFetch({ ok: false, status: 403 }) });
    const r = checkCrawlerAccess(ctx);
    expect(r.score).toBe(70);
    expect(r.evidence.some((e) => e.message.includes('normal UA got HTTP 200, GPTBot UA got HTTP 403'))).toBe(true);
  });

  it('reports could-not-verify when nothing is checkable', () => {
    const r = checkCrawlerAccess(
      makeCtx({
        robots: { url: 'https://example.com/robots.txt', fetch: makeFetch({ ok: false, status: null, error: 'timeout' }), parsed: null },
        target: null,
        targetBotFetch: null,
      }),
    );
    expect(r.score).toBeNull();
    expect(r.evidence.every((e) => e.status === 'unverified')).toBe(true);
  });
});

describe('checkRenderability', () => {
  it('scores a server-rendered article highly', () => {
    const r = checkRenderability(makeCtx());
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  it('caps an empty SPA shell at 20', () => {
    const r = checkRenderability(makeCtx({ target: makePage('https://example.com/guide', fixture('spa-shell.html')) }));
    expect(r.score).toBeLessThanOrEqual(20);
    expect(r.evidence.some((e) => e.message.includes('#root'))).toBe(true);
    expect(r.recommendations.some((rec) => rec.action.includes('content in the initial HTML'))).toBe(true);
  });

  it('states the no-JS limitation', () => {
    const r = checkRenderability(makeCtx());
    expect(r.evidence.some((e) => e.message.includes('does not execute JS'))).toBe(true);
  });

  it('could not verify without HTML', () => {
    const r = checkRenderability(makeCtx({ target: null }));
    expect(r.score).toBeNull();
  });
});

describe('checkStructuredData', () => {
  it('scores rich JSON-LD highly (Article+author+dates, FAQPage, Organization, Person, Breadcrumb)', () => {
    const r = checkStructuredData(makeCtx());
    expect(r.score).toBe(100);
  });

  it('scores zero with a recommendation when no JSON-LD exists', () => {
    const r = checkStructuredData(makeCtx({ target: makePage('https://example.com/guide', fixture('thin-page.html')) }));
    expect(r.score).toBe(0);
    expect(r.recommendations[0].why).toContain('tokenize');
  });

  it('reports invalid JSON-LD blocks as failures', () => {
    const html = '<html><body><script type="application/ld+json">{bad</script></body></html>';
    const r = checkStructuredData(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence.some((e) => e.status === 'fail' && e.message.includes('invalid JSON-LD'))).toBe(true);
  });

  it('warns when Article lacks an author', () => {
    const html = '<script type="application/ld+json">{"@type":"Article","headline":"x","datePublished":"2026-01-01"}</script>';
    const r = checkStructuredData(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence.some((e) => e.status === 'warn' && e.message.includes('author'))).toBe(true);
  });
});

describe('checkAnswerReadiness', () => {
  it('scores the good article at 100 (answer + H1 + question headings + FAQ + lists + table)', () => {
    const r = checkAnswerReadiness(makeCtx());
    expect(r.score).toBe(100);
    expect(r.evidence.some((e) => e.message.includes('Generative Engine Optimization (GEO) is'))).toBe(true);
  });

  it('penalizes a thin page (multiple H1s, no answer, no FAQ)', () => {
    const r = checkAnswerReadiness(makeCtx({ target: makePage('https://example.com/guide', fixture('thin-page.html')) }));
    expect(r.score).toBeLessThanOrEqual(20);
    expect(r.evidence.some((e) => e.message.includes('2 H1 headings'))).toBe(true);
    expect(r.recommendations.some((rec) => rec.action.includes('direct answer'))).toBe(true);
  });

  it('rejects an "is" sentence with a long rambling subject (not a definitional shape)', () => {
    const html =
      '<html><body><main><p>Over the course of the last decade the broader ecommerce personalization market in Europe is growing at a rapid pace according to several industry watchers. More filler text follows here so the page clears the word floor for the checks comfortably today.</p><h1>Topic</h1></main></body></html>';
    const r = checkAnswerReadiness(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence[0].status).toBe('fail');
    expect(r.evidence[0].message).toContain('no direct definitional/answer statement');
  });

  it('accepts a short-subject definitional sentence', () => {
    const html =
      '<html><body><main><p>Generative caching is a technique for reusing model outputs across similar requests. More filler text follows here so the page clears the word floor for the checks comfortably today.</p><h1>Topic</h1></main></body></html>';
    const r = checkAnswerReadiness(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence[0].status).toBe('pass');
    expect(r.evidence[0].message).toContain('Generative caching is');
  });

  it('detects question headings partially (1-2 questions)', () => {
    const html = '<html><body><main><h1>Topic</h1><h2>How does it work?</h2><p>The system is a pipeline that processes text through several stages and produces structured output for downstream consumers.</p></main></body></html>';
    const r = checkAnswerReadiness(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence.some((e) => e.message.includes('1 question-formatted heading'))).toBe(true);
  });

  it('could not verify without HTML', () => {
    expect(checkAnswerReadiness(makeCtx({ target: null })).score).toBeNull();
  });

  it('on a no-content shell: scores 0 but redirects advice to renderability instead of FAQ/heading recs', () => {
    const r = checkAnswerReadiness(makeCtx({ target: makePage('https://example.com/guide', fixture('spa-shell.html')) }));
    expect(r.score).toBe(0);
    expect(r.evidence.some((e) => e.message.includes('no extractable main content'))).toBe(true);
    expect(r.recommendations).toHaveLength(1);
    expect(r.recommendations[0].action).toContain('Renderability');
    expect(r.recommendations.some((rec) => rec.action.includes('FAQ'))).toBe(false);
  });
});

describe('checkTopicalFocus', () => {
  it('scores the good article at 100 (title, description, H1 agreement, topic echo, canonical, OG)', () => {
    const r = checkTopicalFocus(makeCtx());
    expect(r.score).toBe(100);
    expect(r.weight).toBe(3);
    expect(r.evidence.some((e) => e.status === 'pass' && e.message.includes('title and H1 agree'))).toBe(true);
    expect(r.evidence.some((e) => e.status === 'pass' && e.message.includes('covers the stated topic'))).toBe(true);
  });

  it('scores a thin unfocused page low with metadata recommendations', () => {
    const r = checkTopicalFocus(makeCtx({ target: makePage('https://example.com/guide', fixture('thin-page.html')) }));
    expect(r.score).toBeLessThanOrEqual(20);
    expect(r.recommendations.some((rec) => rec.action.includes('meta description'))).toBe(true);
    expect(r.recommendations.some((rec) => rec.action.includes('Align the H1'))).toBe(true);
  });

  it('flags a title/H1 topic mismatch', () => {
    const html =
      '<html><head><title>Industrial Pump Maintenance Guide</title></head><body><main><h1>Our Company Blog</h1><p>Filler content that talks about many things in general terms without naming any single topic clearly across enough words to pass the floor.</p></main></body></html>';
    const r = checkTopicalFocus(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence.some((e) => e.status === 'fail' && e.message.includes('share no content words'))).toBe(true);
  });

  it('detects body drift from the stated topic', () => {
    const html =
      '<html><head><title>Solar Panel Installation Costs</title><meta name="description" content="What solar panel installation costs in 2026, itemized by system size and region."></head><body><main><h1>Solar Panel Installation Costs</h1><p>Our team has decades of combined experience and a passion for customer service. We pride ourselves on integrity, family values and community involvement across the region every single day.</p></main></body></html>';
    const r = checkTopicalFocus(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence.some((e) => e.status === 'fail' && e.message.includes('rarely mentions the topic'))).toBe(true);
    expect(r.recommendations.some((rec) => rec.action.includes('substantively cover the topic'))).toBe(true);
  });

  it('on a no-content shell: still scores metadata but redirects the content rec to renderability', () => {
    const r = checkTopicalFocus(makeCtx({ target: makePage('https://example.com/guide', fixture('spa-shell.html')) }));
    expect(r.score).toBeLessThanOrEqual(20);
    expect(r.recommendations.some((rec) => rec.action.includes('Renderability'))).toBe(true);
  });

  it('cites the 2026 research in recommendation whys', () => {
    const r = checkTopicalFocus(makeCtx({ target: makePage('https://example.com/guide', fixture('thin-page.html')) }));
    const whys = r.recommendations.map((rec) => rec.why).join(' ');
    expect(whys).toContain('SIGIR 2026');
  });

  it('could not verify without HTML', () => {
    expect(checkTopicalFocus(makeCtx({ target: null })).score).toBeNull();
  });
});

describe('checkEvidenceDensity', () => {
  it('scores stat/quote/citation-rich content highly (weight recalibrated to medium in v1.3)', () => {
    const r = checkEvidenceDensity(makeCtx());
    expect(r.score).toBe(100);
    expect(r.weight).toBe(2);
  });

  it('scores an unevidenced page at 0 and cites the GEO research numbers in recommendations', () => {
    const r = checkEvidenceDensity(makeCtx({ target: makePage('https://example.com/guide', fixture('thin-page.html')) }));
    expect(r.score).toBe(0);
    const whys = r.recommendations.map((rec) => rec.why).join(' ');
    expect(whys).toContain('+25.9%');
    expect(whys).toContain('+27.8%');
    expect(whys).toContain('+24.9%');
  });

  it('on a no-content shell: scores 0 with a single root-cause rec, not stat/quote/citation recs', () => {
    const r = checkEvidenceDensity(makeCtx({ target: makePage('https://example.com/guide', fixture('spa-shell.html')) }));
    expect(r.score).toBe(0);
    expect(r.recommendations).toHaveLength(1);
    expect(r.recommendations[0].action).toContain('Renderability');
  });

  it('counts percent-sign, currency and word-unit statistics', () => {
    const html =
      '<html><body><main><p>Traffic grew 24.9% year over year. The rebuild cost $3 million and shipped in 30 days.</p></main></body></html>';
    const r = checkEvidenceDensity(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence.some((e) => e.message.includes('3 statistic(s)'))).toBe(true);
  });

  it('does not count same-domain links as outbound citations', () => {
    const html = '<html><body><main><p>Some ordinary body copy that talks about the topic at hand in a fairly plain way without numbers.</p><a href="https://example.com/other">internal</a><a href="https://www.example.com/other2">internal www</a></main></body></html>';
    const r = checkEvidenceDensity(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence.some((e) => e.message.includes('0 outbound citation link(s)'))).toBe(true);
  });
});

describe('checkFreshness', () => {
  it('scores 100 for content updated within ~3 months (weight recalibrated to high in v1.3)', () => {
    const r = checkFreshness(makeCtx(), NOW);
    expect(r.score).toBe(100);
    expect(r.weight).toBe(3);
    expect(r.evidence.some((e) => e.message.includes('2026-06-20'))).toBe(true);
  });

  it('scores old content low', () => {
    const html = '<html><body><main><p>Published on <time datetime="2024-01-05">January 5, 2024</time></p></main></body></html>';
    const r = checkFreshness(makeCtx({ target: makePage('https://example.com/guide', html) }), NOW);
    expect(r.score).toBe(20);
  });

  it('scores 30 with a recommendation when no dates exist anywhere', () => {
    const r = checkFreshness(makeCtx({ target: makePage('https://example.com/guide', fixture('thin-page.html')) }), NOW);
    expect(r.score).toBe(30);
    expect(r.recommendations[0].why).toContain('~3-month');
  });

  it('caps header-only freshness at 60 (deploy time is weak evidence)', () => {
    const page = makePage('https://example.com/guide', fixture('thin-page.html'));
    page.fetch.headers['last-modified'] = 'Mon, 29 Jun 2026 10:00:00 GMT';
    const r = checkFreshness(makeCtx({ target: page }), NOW);
    expect(r.score).toBe(60);
  });

  it('uses sitemap lastmod for the audited URL', () => {
    const r = checkFreshness(
      makeCtx({
        target: makePage('https://example.com/guide', fixture('thin-page.html')),
        sitemap: {
          url: 'https://example.com/sitemap.xml',
          fetch: makeFetch(),
          entries: [{ loc: 'https://example.com/guide', lastmod: '2026-06-20' }],
        },
      }),
      NOW,
    );
    expect(r.score).toBe(100);
    expect(r.evidence.some((e) => e.message.includes('sitemap <lastmod>'))).toBe(true);
  });

  it('detects abbreviated-month visible dates ("Jun 5, 2026")', () => {
    const html = '<html><body><main><p>Updated Jun 20, 2026 — some article text here.</p></main></body></html>';
    const r = checkFreshness(makeCtx({ target: makePage('https://example.com/guide', html) }), NOW);
    expect(r.score).toBe(100);
    expect(r.evidence.some((e) => e.message.includes('Jun 20, 2026'))).toBe(true);
  });

  it('ignores future dates', () => {
    const html = '<html><body><main><p><time datetime="2030-01-01">2030</time></p></main></body></html>';
    const r = checkFreshness(makeCtx({ target: makePage('https://example.com/guide', html) }), NOW);
    expect(r.score).toBe(30);
  });
});

describe('checkEntityEeat', () => {
  it('scores a fully-attributed page at 100', () => {
    const r = checkEntityEeat(makeCtx());
    expect(r.score).toBe(100);
  });

  it('scores an anonymous page low with recommendations', () => {
    const r = checkEntityEeat(
      makeCtx({
        target: makePage('https://example.com/guide', fixture('thin-page.html')),
        aboutPage: makePage('https://example.com/about', null, { ok: false, status: 404 }),
        faviconStatus: 404,
      }),
    );
    expect(r.score).toBeLessThanOrEqual(20);
    expect(r.recommendations.some((rec) => rec.action.includes('byline'))).toBe(true);
    expect(r.recommendations.some((rec) => rec.action.includes('/about'))).toBe(true);
  });

  it('detects org name consistency between title, og:site_name and Organization schema', () => {
    const r = checkEntityEeat(makeCtx());
    expect(r.evidence.some((e) => e.message.includes('org name consistent'))).toBe(true);
  });

  it('warns when org names disagree', () => {
    const html =
      '<html><head><title>Page | Alpha Corp</title><meta property="og:site_name" content="Beta Inc"></head><body><main><p>content</p></main></body></html>';
    const r = checkEntityEeat(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence.some((e) => e.status === 'warn' && e.message.includes('disagree'))).toBe(true);
  });

  it('accepts a brand-prefix title ("Brand | Tagline") when it matches another source', () => {
    const html =
      '<html><head><title>Truenote | Cited Knowledge Answers</title><meta property="og:site_name" content="Truenote"></head><body><main><p>content here for the page</p></main></body></html>';
    const r = checkEntityEeat(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence.some((e) => e.status === 'pass' && e.message.includes('org name consistent'))).toBe(true);
    expect(r.evidence.some((e) => e.message.includes('disagree'))).toBe(false);
  });

  it('accepts a WebSite-schema name as an org-name source', () => {
    const html =
      '<html><head><title>Cited Answers | Truenote</title><script type="application/ld+json">{"@type":"WebSite","name":"Truenote"}</script></head><body><main><p>content here for the page</p></main></body></html>';
    const r = checkEntityEeat(makeCtx({ target: makePage('https://example.com/guide', html) }));
    expect(r.evidence.some((e) => e.status === 'pass' && e.message.includes('org name consistent'))).toBe(true);
  });
});

describe('checkLlmsTxt', () => {
  it('recommends (low priority, honest framing) when absent', () => {
    const r = checkLlmsTxt(makeCtx());
    expect(r.weight).toBe(0);
    expect(r.recommendations[0].why).toContain('~10%');
    expect(r.recommendations[0].impact).toBe(1);
  });

  it('validates a well-formed llms.txt', () => {
    const r = checkLlmsTxt(makeCtx({ llmsTxt: { url: 'https://example.com/llms.txt', fetch: makeFetch({ body: fixture('llms-good.txt') }) } }));
    expect(r.evidence.some((e) => e.status === 'pass' && e.message.includes('starts with an H1'))).toBe(true);
    expect(r.evidence.some((e) => e.message.includes('2 markdown link(s)'))).toBe(true);
  });

  it('flags contradiction with robots.txt AI-bot blocks', () => {
    const r = checkLlmsTxt(
      makeCtx({
        robots: robotsCtxFrom('robots-blocking.txt'),
        llmsTxt: { url: 'https://example.com/llms.txt', fetch: makeFetch({ body: fixture('llms-good.txt') }) },
      }),
    );
    expect(r.evidence.some((e) => e.status === 'warn' && e.message.includes('contradiction'))).toBe(true);
  });

  it('flags an HTML soft-404 response', () => {
    const r = checkLlmsTxt(makeCtx({ llmsTxt: { url: 'https://example.com/llms.txt', fetch: makeFetch({ body: '<!DOCTYPE html><html></html>' }) } }));
    expect(r.evidence.some((e) => e.status === 'warn' && e.message.includes('soft-404'))).toBe(true);
  });
});
