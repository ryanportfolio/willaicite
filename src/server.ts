import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
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
}

/**
 * Local web UI for geo-audit. Zero dependencies: node:http serving a single
 * embedded HTML page, plus an SSE endpoint that streams real fetch progress
 * (never cosmetic/fake progress) and the final result.
 */
export function createAuditServer(opts: ServerOptions = {}): Server {
  const uiHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
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

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(uiHtml);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/audit') {
      const gate = limiter.hit(clientIp(req));
      if (!gate.allowed) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(Math.ceil(gate.retryAfterMs / 1000)) });
        res.end(JSON.stringify({ error: 'rate limit exceeded — try again later' }));
        return;
      }
      if (inFlight >= maxConcurrent) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
        res.end(JSON.stringify({ error: 'server busy — too many audits in progress' }));
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

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

export function startServer(port: number, opts: ServerOptions = {}): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createAuditServer(opts);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      process.stderr.write(`geo-audit v${VERSION} UI listening on http://127.0.0.1:${actualPort}\n`);
      resolve(server);
    });
  });
}
