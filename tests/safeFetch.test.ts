import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createGuardedFetcher } from '../src/safeFetch.js';

describe('guarded fetcher — pre-connection guards', () => {
  it('rejects non-http(s) schemes without resolving', async () => {
    const f = createGuardedFetcher({
      resolveHost: async () => {
        throw new Error('should not resolve');
      },
    });
    const r = await f('file:///etc/passwd');
    expect(r.status).toBeNull();
    expect(r.error).toMatch(/scheme/i);
  });

  it('rejects a disallowed port', async () => {
    const f = createGuardedFetcher({ resolveHost: async () => [{ address: '93.184.216.34', family: 4 }] });
    const r = await f('http://example.com:22/');
    expect(r.error).toMatch(/port/i);
  });

  it('rejects a host that resolves to a private address (no throw)', async () => {
    const f = createGuardedFetcher({ resolveHost: async () => [{ address: '10.0.0.5', family: 4 }] });
    const r = await f('http://internal.example/');
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.error).toMatch(/private|reserved|blocked/i);
  });

  it('rejects if ANY resolved address is private (mixed A records)', async () => {
    const f = createGuardedFetcher({
      resolveHost: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    const r = await f('http://rebind.example/');
    expect(r.error).toMatch(/private|reserved|blocked/i);
  });

  it('blocks a real loopback target under the default policy', async () => {
    const f = createGuardedFetcher();
    const r = await f('http://127.0.0.1:80/');
    expect(r.error).toMatch(/private|reserved|blocked/i);
  });
});

// Local test server. Policy below sets blockPrivateHosts:false so we may hit 127.0.0.1.
let srv: Server;
let baseUrl: string;
beforeAll(async () => {
  srv = createServer((req, res) => {
    if (req.url === '/plain') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>hello plain</h1>');
      return;
    }
    if (req.url === '/gz') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from('<h1>hello gzip</h1>')));
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('x'.repeat(1_000_000));
      return;
    }
    if (req.url === '/r1') {
      res.writeHead(302, { location: '/r2' });
      res.end();
      return;
    }
    if (req.url === '/r2') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>redirected</h1>');
      return;
    }
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 5000);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const localFetcher = () => createGuardedFetcher({ policy: { blockPrivateHosts: false, allowedPorts: null } });

describe('guarded transport (localhost, guards relaxed)', () => {
  it('fetches plain HTML', async () => {
    const r = await localFetcher()(baseUrl + '/plain');
    expect(r.status).toBe(200);
    expect(r.body).toContain('hello plain');
    expect(r.ok).toBe(true);
  });
  it('decompresses gzip', async () => {
    const r = await localFetcher()(baseUrl + '/gz');
    expect(r.body).toContain('hello gzip');
  });
  it('follows a redirect and reports finalUrl', async () => {
    const r = await localFetcher()(baseUrl + '/r1');
    expect(r.body).toContain('redirected');
    expect(r.finalUrl).toBe(baseUrl + '/r2');
  });
  it('stops a redirect loop and returns an error, never hangs', async () => {
    const r = await localFetcher()(baseUrl + '/loop');
    expect(r.error).toMatch(/redirect/i);
  });
  it('caps the body at maxBytes without loading it all', async () => {
    const r = await localFetcher()(baseUrl + '/big', { maxBytes: 1000 });
    expect((r.body ?? '').length).toBeLessThanOrEqual(1000);
    expect(r.status).toBe(200);
  });
  it('times out slow responses and never throws', async () => {
    const r = await localFetcher()(baseUrl + '/slow', { timeoutMs: 300 });
    expect(r.status).toBeNull();
    expect(r.error).toMatch(/timeout/i);
  });
  it('discardBody returns no body but a status', async () => {
    const r = await localFetcher()(baseUrl + '/plain', { discardBody: true });
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });
});
