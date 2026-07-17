# geo-audit

Point it at a URL and get a scored **GEO (Generative Engine Optimization) audit**: how ready the site is to be retrieved and cited by AI answer engines (ChatGPT, Perplexity, Google AI Overviews, Claude), plus prioritized recommendations.

**Deterministic by design (v1):** no LLM calls, only rule-based checks — the same input always produces the same score.

```
$ geo-audit example.com

# GEO Audit — example.com
## Overall score: 44/100
**Poor — this site is largely invisible or unciteable to AI answer engines as-is.**
...
```

## Install

Requires Node 20+.

```bash
npm install
npm run build
npm link        # exposes the `geo-audit` command
# or run without linking:
node dist/cli.js <url>
```

## Usage

```
geo-audit <url> [--json] [--out report.md]
geo-audit serve [--port 4173]

--json        machine-readable JSON instead of markdown
--out <file>  write the report to a file instead of stdout
--port <n>    port for the local web UI (default 4173)
```

## Web UI

`geo-audit serve` starts a local, zero-dependency web UI (nothing leaves your machine except the audited site's fetches). Enter a URL and watch the real fetch progress stream in (Server-Sent Events — every progress line is an actual request, never cosmetic), then get the full report: overall score, per-dimension bars with expandable evidence, the prioritized fix-first list, and one-click downloads of `report.md` / `result.json`. Same audit engine as the CLI — identical input produces the identical score in both.

## What it fetches (politely)

- Identifies as `geo-audit/1.0` and **respects robots.txt for its own fetching** (if robots.txt disallows the tool for a path, that page is skipped and reported as such).
- Max ~10 pages: the given URL, the homepage, an about page, and a few pages from the sitemap if present — plus robots.txt, sitemap.xml, llms.txt and favicon.
- Per-request timeout with graceful failure: a failed fetch or crashed check is reported as **"could not verify"** and excluded from the weighted score. It is never guessed and never crashes the audit.

## The seven dimensions

Each scores 0–100 with per-check evidence lines (e.g. the exact robots.txt line that blocks a bot). The overall score is the weighted average of the dimensions that could be verified.

| Dimension | Weight | What it measures |
|---|---|---|
| **AI crawler access** | high | robots.txt verdicts for GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended and Bingbot; meta robots / X-Robots-Tag noindex; and a UA differential test — the page is fetched once with a normal UA and once with GPTBot's UA string to catch CDN/WAF-level bot blocking that robots.txt doesn't show. |
| **Renderability** | high | How much content is extractable from the raw HTML with no JS execution — which is how GPTBot, ClaudeBot and PerplexityBot see the page. Flags empty SPA shells (`<div id="root">` with no server-rendered text), low text volume, and low text-to-HTML ratio. |
| **Structured data** | medium | JSON-LD presence and validity: Article/BlogPosting (with author and dates), FAQPage, Organization, Person, BreadcrumbList. Weighted honestly — schema mainly moves Google AI Overviews and entity trust; ChatGPT/Claude/Perplexity largely tokenize the text rather than parse the graph, and the recommendations say so. |
| **Answer-readiness** | high | Can an engine lift an answer straight off the page? Direct definitional statement ("X is …") in the first ~200 tokens, question-formatted headings, an FAQ section, lists/tables for enumerable content, one clear H1. |
| **Evidence density** | high | Statistics (numbers with units/%/$), quotations, and outbound citation links in the main content. Grounded in the original GEO research (Aggarwal et al., KDD 2024): quotations +27.8%, statistics +25.9%, citing sources +24.9% generative-engine visibility lift — those numbers appear in the recommendations so they carry their evidence. |
| **Freshness** | medium | Visible publish/updated dates, JSON-LD dates, `<time>` elements, sitemap `<lastmod>`, Last-Modified headers. Content older than ~3 months is flagged — AI engines have a strong recency bias and citations drop off sharply past that. Header-only dates are capped (they usually reflect deploys, not edits). |
| **Entity & E-E-A-T** | medium | Author bylines, an about page, org-name consistency across title/schema/og:site_name, contact info, favicon, Open Graph metadata — the signals that let an engine resolve who is behind the content. |

**Also checked (informational, unscored):** `llms.txt` presence, well-formedness, and consistency with robots.txt. Honest framing: adoption is ~10% and the major AI crawlers mostly skip it today, but IDE coding agents and Lighthouse's agentic-browsing audit do use it, and it costs nothing.

## Report format

- Overall score and a one-line verdict up top.
- Per-dimension sections: score, what passed, what failed — with exact evidence (the robots.txt line, the HTTP statuses, the matched sentence).
- A **"Fix first"** list ordered by impact-per-effort, where every recommendation states *why* (the mechanism or the research number), not just what to do.
- No fabricated metrics anywhere: anything unverifiable says "could not verify".

## Development

```bash
npm test          # Vitest suite over fixture HTML/robots.txt files
npm run dev <url> # run from source via tsx
```

## Limitations (honest ones)

- **No JS rendering.** Renderability is a heuristic on raw HTML (shell detection, text volume/ratio). Pages that hydrate real server-rendered HTML are judged fairly; lazy-loaded sections are undercounted. No headless browser in v1.
- **Heuristic answer-readiness.** "Direct answer" detection is lexical (subject + is/are/means/helps near the top), not semantic. A well-written page can fail the pattern and vice versa.
- **No live AI-engine querying.** This measures retrieval/citation *readiness*, not whether engines actually cite you today.
- Robots matching implements the practically relevant parts of RFC 9309 (longest-match, allow-wins-ties, `*`/`$` wildcards), not every percent-encoding corner case.
- The evidence-density research numbers come from one study (Aggarwal et al., "GEO: Generative Engine Optimization", KDD 2024) measured on Perplexity-style engines; treat them as directional, not gospel.

## v2 (planned, not built)

**Live share-of-voice probing:** query multiple AI engines (ChatGPT, Perplexity, Claude, AI Overviews) with a tracked prompt list, multiple samples per prompt — single-sample checks measure randomness, not visibility — and report brand mentions vs competitors over time. This requires live engine access and gives non-deterministic results, which is why it is out of scope for the deterministic v1.

## License

MIT
