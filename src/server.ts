import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit, VERSION } from './audit.js';
import { renderMarkdown } from './report.js';
import { prioritize } from './score.js';
import type { Fetcher } from './fetcher.js';
import { publicFetch } from './safeFetch.js';
import { createRateLimiter, type RateLimiter } from './rateLimiter.js';

export interface ServerOptions {
  /** Injectable for tests; defaults to the SSRF-guarded public fetcher. */
  fetcher?: Fetcher;
  delayMs?: number;
  /** Per-IP limiter. Defaults to 10 audits / 10 min. */
  rateLimiter?: RateLimiter;
  /** Max simultaneous audits. Default 4. */
  maxConcurrent?: number;
  /** Trust X-Forwarded-For (set true only behind a proxy you control). Default false. */
  trustProxy?: boolean;
  /**
   * Directory of the prebuilt landing site served at '/'. Default: auto-detect
   * ../site/dist next to the package (present on deploys that build the
   * landing). Pass null to disable and serve the audit UI at '/' (local CLI
   * without a landing build, tests).
   */
  landingDir?: string | null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Local web UI for geo-audit. Zero dependencies: node:http serving a single
 * embedded HTML page, plus an SSE endpoint that streams real fetch progress
 * (never cosmetic/fake progress) and the final result.
 */
export function createAuditServer(opts: ServerOptions = {}): Server {
  const uiHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const defaultLanding = fileURLToPath(new URL('../site/dist', import.meta.url));
  const landingDir =
    opts.landingDir === undefined
      ? existsSync(join(defaultLanding, 'index.html'))
        ? defaultLanding
        : null
      : opts.landingDir;
  const landingRoot = landingDir ? resolve(landingDir) : null;
  const fetcher = opts.fetcher ?? publicFetch;
  const limiter = opts.rateLimiter ?? createRateLimiter({ windowMs: 10 * 60_000, max: 10 });
  const maxConcurrent = opts.maxConcurrent ?? 4;
  const trustProxy = opts.trustProxy ?? false;
  let inFlight = 0;

  const clientIp = (req: IncomingMessage): string => {
    if (trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  /** Serve a file from the landing build; Astro's directory URLs ('/about')
   * resolve to about/index.html. Returns false when unmatched. */
  const serveLanding = (pathname: string, res: ServerResponse): boolean => {
    if (!landingRoot) return false;
    let p: string;
    try {
      p = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (p.includes('\0')) return false;
    if (p.endsWith('/')) p += 'index.html';
    for (const candidate of [p, p + '/index.html']) {
      const abs = resolve(landingRoot, '.' + '/' + candidate.replace(/^\/+/, ''));
      // Traversal guard: the resolved path must stay inside the landing build.
      if (abs !== landingRoot && !abs.startsWith(landingRoot + sep)) continue;
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      const ext = extname(abs).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
      });
      res.end(readFileSync(abs));
      return true;
    }
    return false;
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Canonical host: www serves a valid cert via its own domain attachment,
    // then 301s to the apex so one origin carries all the SEO signals.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host.startsWith('www.')) {
      res.writeHead(301, { location: `https://${host.slice(4)}${req.url ?? '/'}` });
      res.end();
      return;
    }

    // The audit app: at /audit when the landing occupies '/', and also at '/'
    // when there is no landing build (local CLI, tests).
    const appPaths = ['/audit', '/audit/', '/audit/index.html'];
    if (!landingRoot) appPaths.push('/', '/index.html');
    if (req.method === 'GET' && appPaths.includes(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(uiHtml);
      return;
    }

    // Legacy path: the app shipped at /app before moving to /audit. Redirect
    // permanently, preserving the query (?url= prefill links in the wild).
    if (req.method === 'GET' && ['/app', '/app/', '/app/index.html'].includes(url.pathname)) {
      res.writeHead(301, { location: '/audit' + url.search });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/audit') {
      const gate = limiter.hit(clientIp(req));
      if (!gate.allowed) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(Math.ceil(gate.retryAfterMs / 1000)) });
        res.end(JSON.stringify({ error: 'rate limit exceeded; try again later' }));
        return;
      }
      if (inFlight >= maxConcurrent) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
        res.end(JSON.stringify({ error: 'server busy; too many audits in progress' }));
        return;
      }

      const target = url.searchParams.get('url')?.trim();
      if (!target) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing ?url=' }));
        return;
      }
      try {
        new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `invalid URL "${target}"` }));
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      const send = (event: string, data: unknown) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      inFlight++;
      try {
        const result = await runAudit(target, {
          fetcher,
          delayMs: opts.delayMs,
          onProgress: (message) => send('progress', { message }),
        });
        send('result', { result, fixFirst: prioritize(result.dimensions).concat(prioritize(result.informational)), markdown: renderMarkdown(result) });
      } catch (err) {
        send('fatal', { error: err instanceof Error ? err.message : String(err) });
      } finally {
        inFlight--;
      }
      res.end();
      return;
    }

    if (req.method === 'GET' && serveLanding(url.pathname, res)) return;

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

export function startServer(port: number, opts: ServerOptions = {}, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createAuditServer(opts);
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      process.stderr.write(`geo-audit v${VERSION} UI listening on http://${host}:${actualPort}\n`);
      resolve(server);
    });
  });
}
