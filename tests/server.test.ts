import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditServer } from '../src/server.js';
import type { Fetcher } from '../src/fetcher.js';
import { createRateLimiter } from '../src/rateLimiter.js';
import { makeFetch, fixture } from './helpers.js';

/** Offline fake site: robots allows all, target is the good article. */
const fakeFetcher: Fetcher = async (url, opts) => {
  const u = new URL(url);
  if (u.pathname === '/robots.txt') return makeFetch({ body: fixture('robots-allow-all.txt'), finalUrl: url });
  if (u.pathname === '/sitemap.xml') return makeFetch({ body: fixture('sitemap.xml'), finalUrl: url, headers: { 'content-type': 'application/xml' } });
  if (u.pathname === '/llms.txt') return makeFetch({ ok: false, status: 404, body: null, finalUrl: url });
  if (u.pathname === '/favicon.ico') return makeFetch({ finalUrl: url });
  return makeFetch({
    body: opts?.discardBody ? null : fixture('article-good.html'),
    finalUrl: url,
    headers: { 'content-type': 'text/html' },
  });
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createAuditServer({ fetcher: fakeFetcher, delayMs: 0, landingDir: null });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('audit server', () => {
  it('serves the UI at / when no landing build is configured', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('willaicite');
    expect(html).toContain('/api/audit');
  });

  it('serves the UI at /app in both modes', async () => {
    const res = await fetch(base + '/app');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/api/audit');
  });

  it('301s www hosts to the apex, preserving the path', async () => {
    // fetch/undici refuses custom Host headers, so use raw http.request.
    const port = (server.address() as AddressInfo).port;
    const { status, location } = await new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/app?url=example.com', headers: { host: 'www.willaicite.com' } },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, location: res.headers.location });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(301);
    expect(location).toBe('https://willaicite.com/app?url=example.com');
  });

  it('rejects a missing url param with 400', async () => {
    const res = await fetch(base + '/api/audit');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('missing');
  });

  it('rejects an invalid url with 400', async () => {
    const res = await fetch(base + '/api/audit?url=' + encodeURIComponent('http://'));
    expect(res.status).toBe(400);
  });

  it('404s unknown paths', async () => {
    const res = await fetch(base + '/nope');
    expect(res.status).toBe(404);
  });

  it('streams progress events then a full result over SSE', async () => {
    const res = await fetch(base + '/api/audit?url=example.com/guide');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();

    const events = text.split('\n\n').filter(Boolean).map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });

    const progress = events.filter((e) => e.event === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress[0].data.message).toContain('robots.txt');
    expect(progress.some((e) => e.data.message.includes('(as GPTBot)'))).toBe(true);

    const result = events.find((e) => e.event === 'result');
    expect(result).toBeDefined();
    expect(result!.data.result.overallScore).toBeGreaterThanOrEqual(85);
    expect(result!.data.result.dimensions).toHaveLength(8);
    expect(Array.isArray(result!.data.fixFirst)).toBe(true);
    expect(result!.data.markdown).toContain('# GEO Audit');
  });
});

describe('audit server — landing mode', () => {
  it('serves the landing at /, directory URLs, and the app at /app; blocks traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-landing-'));
    mkdirSync(join(dir, 'about'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<html><body>LANDING</body></html>');
    writeFileSync(join(dir, 'about', 'index.html'), '<html><body>ABOUT</body></html>');
    writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\nAllow: /\n');
    const s = createAuditServer({ fetcher: fakeFetcher, delayMs: 0, landingDir: dir });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = (s.address() as AddressInfo).port;
    const b = `http://127.0.0.1:${p}`;

    expect(await (await fetch(b + '/')).text()).toContain('LANDING');
    expect(await (await fetch(b + '/about')).text()).toContain('ABOUT');
    const robots = await fetch(b + '/robots.txt');
    expect(robots.headers.get('content-type')).toContain('text/plain');
    expect(await (await fetch(b + '/app')).text()).toContain('/api/audit');
    expect((await fetch(b + '/..%2f..%2fpackage.json')).status).toBe(404);
    expect((await fetch(b + '/nope')).status).toBe(404);

    await new Promise<void>((r) => s.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('audit server — abuse controls', () => {
  it('returns 429 once the per-IP limit is exceeded', async () => {
    const s = createAuditServer({
      fetcher: fakeFetcher,
      delayMs: 0,
      landingDir: null,
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 }),
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = (s.address() as AddressInfo).port;
    const first = await fetch(`http://127.0.0.1:${p}/api/audit?url=example.com`);
    await first.text();
    expect(first.status).toBe(200);
    const second = await fetch(`http://127.0.0.1:${p}/api/audit?url=example.com`);
    expect(second.status).toBe(429);
    expect((await second.json()).error).toMatch(/rate limit/i);
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('returns 503 when the concurrency cap is reached', async () => {
    const slow: Fetcher = async (url, opts) => {
      await new Promise((r) => setTimeout(r, 50));
      return fakeFetcher(url, opts);
    };
    const s = createAuditServer({ fetcher: slow, delayMs: 0, maxConcurrent: 1, landingDir: null });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = (s.address() as AddressInfo).port;
    const a = fetch(`http://127.0.0.1:${p}/api/audit?url=example.com/a`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 10));
    const b = await fetch(`http://127.0.0.1:${p}/api/audit?url=example.com/b`);
    expect(b.status).toBe(503);
    expect((await b.json()).error).toMatch(/busy/i);
    await a;
    await new Promise<void>((r) => s.close(() => r()));
  });
});
