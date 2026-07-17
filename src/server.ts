import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { runAudit, VERSION } from './audit.js';
import { renderMarkdown } from './report.js';
import { prioritize } from './score.js';
import type { Fetcher } from './fetcher.js';

export interface ServerOptions {
  /** Injectable for tests; defaults to the real polite fetcher. */
  fetcher?: Fetcher;
  delayMs?: number;
}

/**
 * Local web UI for geo-audit. Zero dependencies: node:http serving a single
 * embedded HTML page, plus an SSE endpoint that streams real fetch progress
 * (never cosmetic/fake progress) and the final result.
 */
export function createAuditServer(opts: ServerOptions = {}): Server {
  const uiHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(uiHtml);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/audit') {
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

      try {
        const result = await runAudit(target, {
          fetcher: opts.fetcher,
          delayMs: opts.delayMs,
          onProgress: (message) => send('progress', { message }),
        });
        send('result', { result, fixFirst: prioritize(result.dimensions).concat(prioritize(result.informational)), markdown: renderMarkdown(result) });
      } catch (err) {
        send('fatal', { error: err instanceof Error ? err.message : String(err) });
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
