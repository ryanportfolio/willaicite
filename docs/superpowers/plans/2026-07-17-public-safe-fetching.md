# Public-Safe Fetching for Hosted willaicite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `geo-audit`'s hosted server safe to expose to the public internet by closing the Server-Side Request Forgery (SSRF) hole in its fetcher and adding per-IP rate limiting and a global concurrency cap — without adding a runtime dependency or changing the local CLI's behavior.

**Architecture:** The current `politeFetch` uses global `fetch` with `redirect: 'follow'`, so it will fetch `http://169.254.169.254/`, `localhost`, and any private address on behalf of an anonymous web caller, and it cannot inspect redirect hops. We add a second, guarded fetcher (`publicFetch`) built on `node:https`/`node:http` with a **custom DNS `lookup`** that resolves the hostname, rejects any loopback/private/link-local/reserved address, and pins the socket to the exact validated IP (killing DNS-rebinding). Redirects are followed manually so every hop's scheme, port, and resolved IP are re-validated. The local CLI keeps the permissive `politeFetch` (auditing your own `localhost:3000` is a legitimate CLI use). The server switches to `publicFetch` and gains a fixed-window per-IP rate limiter and an in-flight concurrency cap.

**Tech Stack:** TypeScript (NodeNext ESM, ES2022), `node:https`/`node:http`/`node:dns`/`node:net`/`node:zlib` (all built-in — zero new runtime deps), Vitest. Node 24.

**Scope boundary:** This plan is the pre-launch security/abuse gate only. Two follow-on plans are intentionally out of scope and listed at the end: (1) the Astro marketing/landing site, (2) Fly.io + Caddy deployment. Nothing here should block on those.

---

## File Structure

| File | Responsibility | New/Modified |
|---|---|---|
| `src/ipRules.ts` | Pure IP-address classification: is a v4/v6 string a loopback/private/link-local/reserved/mapped address? No I/O. | Create |
| `src/safeFetch.ts` | Guarded transport: custom DNS lookup + manual redirect + size-abort + decompression + timeout. Exports `createGuardedFetcher()` and the default `publicFetch`. | Create |
| `src/rateLimiter.ts` | Fixed-window per-key rate limiter with injectable clock. | Create |
| `src/fetcher.ts` | Unchanged transport; source of the `Fetcher` / `FetchResult` / `FetchOptions` types that `safeFetch.ts` implements. | Read-only reference |
| `src/server.ts` | Use `publicFetch` by default; apply rate limit + concurrency cap + client-IP extraction; return `429`/`503` on limits. | Modify |
| `src/cli.ts` | `serve` reads env config; add `--local` flag to opt back into the permissive fetcher for private-network testing. | Modify |
| `tests/ipRules.test.ts` | Exhaustive classification tests incl. IPv4-mapped-IPv6 bypasses. | Create |
| `tests/safeFetch.test.ts` | URL/port rejection, injected-resolver IP blocking, live-localhost transport (redirect/gzip/size/timeout) with `blockPrivateHosts:false`. | Create |
| `tests/rateLimiter.test.ts` | Window rollover, per-key isolation, deterministic via injected `now`. | Create |
| `tests/server.test.ts` | Extend: 429 after limit, 503 at concurrency cap, guarded fetcher rejects a private target. | Modify |
| `README.md` | New "Running it as a public service" security section. | Modify |
| `SECURITY.md` | Threat model + the guarantees this code makes and does not make. | Create |

---

## Type contract (defined once, referenced everywhere)

From `src/fetcher.ts` (already exists — do not redefine, import it):

```ts
export interface FetchResult {
  ok: boolean;
  status: number | null;
  headers: Record<string, string>;
  body: string | null;
  finalUrl: string | null;
  error: string | null;
}
export interface FetchOptions { ua?: string; timeoutMs?: number; maxBytes?: number; discardBody?: boolean; }
export type Fetcher = (url: string, opts?: FetchOptions) => Promise<FetchResult>;
```

New types introduced by this plan (referenced by later tasks):

```ts
// src/safeFetch.ts
export interface FetchPolicy {
  /** Allowed destination ports. null = allow any port. Default: {80, 443}. */
  allowedPorts: Set<number> | null;
  /** Reject hosts that resolve to loopback/private/link-local/reserved IPs. Default: true. */
  blockPrivateHosts: boolean;
  /** Max redirect hops to follow. Default: 4. */
  maxRedirects: number;
}
export interface GuardedFetcherOptions {
  policy?: Partial<FetchPolicy>;
  /** Injectable resolver (tests). Returns every address a host resolves to. */
  resolveHost?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}
export function createGuardedFetcher(opts?: GuardedFetcherOptions): Fetcher;
export const publicFetch: Fetcher; // createGuardedFetcher() with defaults

// src/rateLimiter.ts
export interface RateLimiter {
  /** Records a hit for key; returns whether it is under the limit. */
  hit(key: string): { allowed: boolean; retryAfterMs: number };
}
export function createRateLimiter(opts: {
  windowMs: number; max: number; now?: () => number;
}): RateLimiter;
```

---

## Task 1: IP-address classification rules (`src/ipRules.ts`)

This is the security core and the most bug-prone unit (IPv4-mapped-IPv6 is the classic bypass), so it is pure and tested first and hardest.

**Files:**
- Create: `src/ipRules.ts`
- Test: `tests/ipRules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ipRules.test.ts
import { describe, it, expect } from 'vitest';
import { isBlockedAddress } from '../src/ipRules.js';

describe('isBlockedAddress — IPv4', () => {
  it('blocks loopback, private, link-local, CGNAT, unspecified, reserved, multicast', () => {
    for (const ip of [
      '127.0.0.1', '127.0.0.53', '10.0.0.1', '172.16.5.4', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '240.0.0.1', '255.255.255.255', '198.18.0.1',
    ]) expect(isBlockedAddress(ip), ip).toBe(true);
  });
  it('allows ordinary public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1'])
      expect(isBlockedAddress(ip), ip).toBe(false);
  });
});

describe('isBlockedAddress — IPv6', () => {
  it('blocks loopback, ULA, link-local, multicast, unspecified', () => {
    for (const ip of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::'])
      expect(isBlockedAddress(ip), ip).toBe(true);
  });
  it('blocks IPv4-mapped/6to4/NAT64 that embed a private v4 (the bypass)', () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
      '2002:a00:0001::', '64:ff9b::a00:1']) // 6to4 of 10.0.0.1, NAT64 of 10.0.0.1
      expect(isBlockedAddress(ip), ip).toBe(true);
  });
  it('allows ordinary public IPv6', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888'])
      expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it('returns true (fail closed) for unparseable input', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ipRules.test.ts`
Expected: FAIL — `isBlockedAddress` is not a function / module missing.

- [ ] **Step 3: Write the implementation**

```ts
// src/ipRules.ts
import { isIP } from 'node:net';

/**
 * Pure classification of an IP-address string as unsafe for a public-facing
 * fetcher to connect to (loopback, private, link-local, CGNAT, reserved,
 * multicast, unspecified). IPv6 forms that embed an IPv4 address
 * (::ffff:x mapped, 2002::/16 6to4, 64:ff9b::/96 NAT64) are decomposed and the
 * embedded v4 is re-classified — that embedding is the standard SSRF bypass.
 *
 * Fails CLOSED: anything unparseable returns `true` (blocked).
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIPv4(parseIPv4(ip));
  if (kind === 6) {
    const bytes = expandIPv6(ip);
    if (!bytes) return true;
    return isBlockedIPv6(bytes);
  }
  return true; // not a valid IP literal
}

function parseIPv4(ip: string): number[] {
  return ip.split('.').map((o) => Number(o));
}

function isBlockedIPv4(o: number[]): boolean {
  if (o.length !== 4 || o.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return true;
  const [a, b] = o;
  if (a === 0) return true;                         // 0.0.0.0/8 unspecified
  if (a === 10) return true;                        // 10.0.0.0/8 private
  if (a === 127) return true;                       // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;// 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true;                        // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255 broadcast
  return false;
}

/** Expand any IPv6 literal (with `::` compression and optional trailing v4) to 16 octets, or null. */
function expandIPv6(ip: string): number[] | null {
  let head = ip;
  const embeddedV4: number[] = [];
  const lastColon = head.lastIndexOf(':');
  const tail = head.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4.length !== 4 || v4.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
    embeddedV4.push(...v4);
    head = head.slice(0, lastColon + 1) + '0:0'; // replace v4 with two 16-bit groups placeholder
  }
  const parts = head.split('::');
  if (parts.length > 2) return null;
  const toGroups = (s: string) => (s === '' ? [] : s.split(':'));
  const left = toGroups(parts[0]);
  const right = parts.length === 2 ? toGroups(parts[1]) : [];
  const explicit = left.length + right.length;
  const groups: string[] =
    parts.length === 2
      ? [...left, ...Array(8 - explicit).fill('0'), ...right]
      : left;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (i >= 6 && embeddedV4.length === 4) {
      // last two groups were the placeholder — substitute the real embedded v4 octets
      bytes.push(embeddedV4[(i - 6) * 2], embeddedV4[(i - 6) * 2 + 1]);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

function isBlockedIPv6(b: number[]): boolean {
  // Unspecified :: and loopback ::1
  if (b.every((x, i) => (i < 15 ? x === 0 : true)) && (b[15] === 0 || b[15] === 1)) return true;
  // IPv4-mapped ::ffff:0:0/96  -> classify embedded v4
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff)
    return isBlockedIPv4(b.slice(12, 16));
  // IPv4-compatible (deprecated) ::/96 with non-zero tail -> classify embedded v4
  if (b.slice(0, 12).every((x) => x === 0) && !(b[12] === 0 && b[13] === 0 && b[14] === 0))
    return isBlockedIPv4(b.slice(12, 16));
  // NAT64 64:ff9b::/96 -> classify embedded v4
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0))
    return isBlockedIPv4(b.slice(12, 16));
  // 6to4 2002::/16 -> next 32 bits are the embedded v4
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIPv4(b.slice(2, 6));
  // fc00::/7 ULA
  if ((b[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  // ff00::/8 multicast
  if (b[0] === 0xff) return true;
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ipRules.test.ts`
Expected: PASS (all cases). If `2002:a00:0001::` or `64:ff9b::a00:1` fail, the embedded-v4 extraction is off — fix `expandIPv6`/`isBlockedIPv6` before continuing; this is the security-critical path.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: `No errors found`.

- [ ] **Step 6: Commit**

```bash
git add src/ipRules.ts tests/ipRules.test.ts
git commit -m "feat(safe-fetch): pure IP classification with IPv6-embedded-v4 bypass coverage"
```

---

## Task 2: Guarded fetcher — URL/port validation + injected-resolver IP blocking (`src/safeFetch.ts`)

Build the guard's decision logic first, tested with an **injected resolver** so no real DNS or sockets are needed. Transport (redirects/gzip/size/timeout) comes in Task 3.

**Files:**
- Create: `src/safeFetch.ts`
- Test: `tests/safeFetch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/safeFetch.test.ts
import { describe, it, expect } from 'vitest';
import { createGuardedFetcher } from '../src/safeFetch.js';

describe('guarded fetcher — pre-connection guards', () => {
  it('rejects non-http(s) schemes without resolving', async () => {
    const f = createGuardedFetcher({ resolveHost: async () => { throw new Error('should not resolve'); } });
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
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    });
    const r = await f('http://rebind.example/');
    expect(r.error).toMatch(/private|reserved|blocked/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/safeFetch.test.ts`
Expected: FAIL — module/`createGuardedFetcher` missing.

- [ ] **Step 3: Write the implementation (guards + a stub transport)**

```ts
// src/safeFetch.ts
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { Fetcher, FetchResult, FetchOptions } from './fetcher.js';
import { TOOL_UA } from './fetcher.js';
import { isBlockedAddress } from './ipRules.js';

export interface FetchPolicy {
  allowedPorts: Set<number> | null;
  blockPrivateHosts: boolean;
  maxRedirects: number;
}
export interface GuardedFetcherOptions {
  policy?: Partial<FetchPolicy>;
  resolveHost?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

const DEFAULT_POLICY: FetchPolicy = { allowedPorts: new Set([80, 443]), blockPrivateHosts: true, maxRedirects: 4 };

const defaultResolve = (hostname: string): Promise<{ address: string; family: number }[]> =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });

function fail(error: string): FetchResult {
  return { ok: false, status: null, headers: {}, body: null, finalUrl: null, error };
}

function portFor(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

export function createGuardedFetcher(opts: GuardedFetcherOptions = {}): Fetcher {
  const policy: FetchPolicy = { ...DEFAULT_POLICY, ...opts.policy };
  const resolveHost = opts.resolveHost ?? defaultResolve;

  return async function guardedFetch(rawUrl: string, fopts: FetchOptions = {}): Promise<FetchResult> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return fail(`invalid URL: ${rawUrl}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail(`blocked scheme: ${url.protocol}`);
    if (policy.allowedPorts && !policy.allowedPorts.has(portFor(url)))
      return fail(`blocked port: ${portFor(url)} (allowed: ${[...policy.allowedPorts].join(', ')})`);

    // Pre-resolve + validate the initial host so a private target fails fast and offline-testably.
    if (policy.blockPrivateHosts) {
      let addrs: { address: string; family: number }[];
      try {
        addrs = await resolveHost(url.hostname);
      } catch (err) {
        return fail(`DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (addrs.length === 0) return fail('DNS resolution returned no addresses');
      const bad = addrs.find((a) => isBlockedAddress(a.address));
      if (bad) return fail(`blocked: ${url.hostname} resolves to a private or reserved address (${bad.address})`);
    }

    return transport(url, fopts, policy, resolveHost); // implemented in Task 3
  };
}

// --- Task 3 fills this in. Temporary stub so Task 2 compiles and its guard tests pass. ---
async function transport(
  _url: URL,
  _fopts: FetchOptions,
  _policy: FetchPolicy,
  _resolveHost: (h: string) => Promise<{ address: string; family: number }[]>,
): Promise<FetchResult> {
  return fail('transport not yet implemented');
}

export const publicFetch: Fetcher = createGuardedFetcher();
void TOOL_UA; void httpRequest; void httpsRequest; void createGunzip; void createInflate; void createBrotliDecompress;
void (undefined as unknown as IncomingMessage);
```

> Note: the `void …` line silences "unused import" until Task 3 uses them; delete it in Task 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/safeFetch.test.ts`
Expected: PASS (guard tests don't reach the transport stub).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: `No errors found`.

- [ ] **Step 6: Commit**

```bash
git add src/safeFetch.ts tests/safeFetch.test.ts
git commit -m "feat(safe-fetch): URL/port/DNS guards with injectable resolver"
```

---

## Task 3: Guarded transport — pinned lookup, manual redirects, size-abort, decompression, timeout

Replace the `transport` stub with a real `node:https`/`node:http` transport whose custom `lookup` pins the connection to a validated IP (kills DNS-rebinding), follows redirects manually (re-validating each hop), aborts at `maxBytes` (true streaming abort — supersedes the CLI's post-download slice for the hosted path), decompresses gzip/deflate/br, and enforces a whole-request deadline.

**Files:**
- Modify: `src/safeFetch.ts`
- Modify: `tests/safeFetch.test.ts`

- [ ] **Step 1: Add transport tests (live localhost server, policy allows it)**

```ts
// append to tests/safeFetch.test.ts
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { beforeAll, afterAll } from 'vitest';

// Local test server. Policy below sets blockPrivateHosts:false so we may hit 127.0.0.1.
let srv: Server; let baseUrl: string;
beforeAll(async () => {
  srv = createServer((req, res) => {
    if (req.url === '/plain') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>hello plain</h1>'); return; }
    if (req.url === '/gz') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(gzipSync(Buffer.from('<h1>hello gzip</h1>'))); return; }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('x'.repeat(1_000_000)); return; }
    if (req.url === '/r1') { res.writeHead(302, { location: '/r2' }); res.end(); return; }
    if (req.url === '/r2') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>redirected</h1>'); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('late'); }, 5000); return; }
    res.writeHead(404); res.end('nope');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const localFetcher = () => createGuardedFetcher({ policy: { blockPrivateHosts: false, allowedPorts: null } });

describe('guarded transport (localhost, guards relaxed)', () => {
  it('fetches plain HTML', async () => {
    const r = await localFetcher()(baseUrl + '/plain');
    expect(r.status).toBe(200); expect(r.body).toContain('hello plain'); expect(r.ok).toBe(true);
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
    expect(r.status).toBe(200); expect(r.body).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/safeFetch.test.ts`
Expected: FAIL — transport returns `'transport not yet implemented'`.

- [ ] **Step 3: Replace the `transport` stub and delete the `void …` line**

```ts
// src/safeFetch.ts — replace the stub `transport` (and remove the trailing `void …;` line)
function makeLookup(
  resolveHost: (h: string) => Promise<{ address: string; family: number }[]>,
  blockPrivate: boolean,
) {
  // net/http calls: lookup(hostname, options, callback). We resolve ALL addresses,
  // reject if any is blocked (fail closed), and pin the socket to a validated IP.
  return (hostname: string, options: { all?: boolean } | number, cb: Function): void => {
    const done = typeof options === 'function' ? (options as Function) : cb;
    const all = typeof options === 'object' && options?.all === true;
    resolveHost(hostname).then(
      (addrs) => {
        if (addrs.length === 0) return done(new Error('no addresses'));
        if (blockPrivate) {
          const bad = addrs.find((a) => isBlockedAddress(a.address));
          if (bad) return done(new Error(`blocked address ${bad.address}`));
        }
        if (all) done(null, addrs);
        else done(null, addrs[0].address, addrs[0].family);
      },
      (err) => done(err),
    );
  };
}

async function transport(
  startUrl: URL,
  fopts: FetchOptions,
  policy: FetchPolicy,
  resolveHost: (h: string) => Promise<{ address: string; family: number }[]>,
): Promise<FetchResult> {
  const { ua = TOOL_UA, timeoutMs = 12_000, maxBytes = 3_000_000, discardBody = false } = fopts;
  const lookup = makeLookup(resolveHost, policy.blockPrivateHosts) as never;
  const deadline = Date.now() + timeoutMs;
  let url = startUrl;

  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail(`blocked scheme: ${url.protocol}`);
    if (policy.allowedPorts && !policy.allowedPorts.has(portFor(url)))
      return fail(`blocked port: ${portFor(url)}`);

    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail(`timeout after ${timeoutMs}ms`);

    const result = await new Promise<FetchResult | { redirectTo: string }>((resolve) => {
      const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = requester(
        url,
        { method: 'GET', lookup, timeout: remaining, headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br' } },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');

          // Redirect?
          if (status >= 300 && status < 400 && headers['location'] && hop < policy.maxRedirects) {
            res.resume(); // drain
            try { resolve({ redirectTo: new URL(headers['location'], url).href }); }
            catch { resolve(fail(`invalid redirect location: ${headers['location']}`)); }
            return;
          }
          if (status >= 300 && status < 400 && headers['location']) { res.resume(); resolve(fail('too many redirects')); return; }

          if (discardBody) { res.resume(); resolve({ ok: status >= 200 && status < 300, status, headers, body: null, finalUrl: url.href, error: null }); return; }

          const enc = (headers['content-encoding'] || '').toLowerCase();
          const stream =
            enc.includes('br') ? res.pipe(createBrotliDecompress())
            : enc.includes('gzip') ? res.pipe(createGunzip())
            : enc.includes('deflate') ? res.pipe(createInflate())
            : res;

          const chunks: Buffer[] = [];
          let total = 0; let capped = false;
          stream.on('data', (c: Buffer) => {
            if (capped) return;
            total += c.length;
            chunks.push(total > maxBytes ? c.subarray(0, c.length - (total - maxBytes)) : c);
            if (total >= maxBytes) { capped = true; req.destroy(); }
          });
          stream.on('end', () => resolve({ ok: status >= 200 && status < 300, status, headers, body: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)), finalUrl: url.href, error: null }));
          stream.on('error', (e: Error) => { if (capped) resolve({ ok: status >= 200 && status < 300, status, headers, body: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)), finalUrl: url.href, error: null }); else resolve(fail(e.message)); });
        },
      );
      req.on('timeout', () => { req.destroy(); resolve(fail(`timeout after ${timeoutMs}ms`)); });
      req.on('error', (e: Error) => resolve(fail(e.message)));
      req.end();
    });

    if ('redirectTo' in result) { url = new URL(result.redirectTo); continue; }
    return result;
  }
  return fail('too many redirects');
}
```

- [ ] **Step 4: Run the transport tests**

Run: `npx vitest run tests/safeFetch.test.ts`
Expected: PASS (all guard + transport cases). If `/big` returns >1000 chars, the cap arithmetic in the `data` handler is wrong; if `/slow` throws instead of returning an error, a listener is missing.

- [ ] **Step 5: Full suite + typecheck (nothing else regressed)**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `No errors found`, all suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/safeFetch.ts tests/safeFetch.test.ts
git commit -m "feat(safe-fetch): pinned-IP transport with manual redirects, size abort, decompression, timeout"
```

---

## Task 4: Fixed-window rate limiter (`src/rateLimiter.ts`)

Deterministic via an injected clock (matches the codebase's injectable-`now` ethos).

**Files:**
- Create: `src/rateLimiter.ts`
- Test: `tests/rateLimiter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/rateLimiter.test.ts
import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/rateLimiter.js';

describe('createRateLimiter', () => {
  it('allows up to max within a window, then blocks with retryAfter', () => {
    let t = 1000;
    const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
    expect(rl.hit('ip1').allowed).toBe(true);
    expect(rl.hit('ip1').allowed).toBe(true);
    const third = rl.hit('ip1');
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    expect(third.retryAfterMs).toBeLessThanOrEqual(1000);
  });
  it('resets after the window elapses', () => {
    let t = 0;
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
    expect(rl.hit('ip1').allowed).toBe(true);
    expect(rl.hit('ip1').allowed).toBe(false);
    t = 1001;
    expect(rl.hit('ip1').allowed).toBe(true);
  });
  it('isolates keys', () => {
    const t = 0;
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('b').allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/rateLimiter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

```ts
// src/rateLimiter.ts
export interface RateLimiter {
  hit(key: string): { allowed: boolean; retryAfterMs: number };
}

/**
 * Fixed-window per-key limiter. In-memory; entries self-expire on next access
 * so an idle server does not accumulate keys. `now` is injectable for tests.
 */
export function createRateLimiter(opts: { windowMs: number; max: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { windowStart: number; count: number }>();

  return {
    hit(key: string) {
      const t = now();
      const w = windows.get(key);
      if (!w || t - w.windowStart >= opts.windowMs) {
        windows.set(key, { windowStart: t, count: 1 });
        return { allowed: true, retryAfterMs: 0 };
      }
      w.count++;
      if (w.count <= opts.max) return { allowed: true, retryAfterMs: 0 };
      return { allowed: false, retryAfterMs: w.windowStart + opts.windowMs - t };
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/rateLimiter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rateLimiter.ts tests/rateLimiter.test.ts
git commit -m "feat(server): fixed-window per-IP rate limiter with injectable clock"
```

---

## Task 5: Server integration — guarded fetcher, rate limit, concurrency cap, client IP

Wire the pieces into `createAuditServer`: default to `publicFetch`, extract the client IP (trusting `x-forwarded-for` only when configured, since Fly/Caddy set it), reject over-limit callers with `429`, and cap concurrent audits with `503`.

**Files:**
- Modify: `src/server.ts`
- Modify: `tests/server.test.ts`

- [ ] **Step 1: Add the failing tests**

```ts
// append to tests/server.test.ts
import { createRateLimiter } from '../src/rateLimiter.js';

describe('audit server — abuse controls', () => {
  it('returns 429 once the per-IP limit is exceeded', async () => {
    const s = createAuditServer({ fetcher: fakeFetcher, delayMs: 0, rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 }) });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = (s.address() as import('node:net').AddressInfo).port;
    const first = await fetch(`http://127.0.0.1:${p}/api/audit?url=example.com`);
    expect(first.status).toBe(200);
    const second = await fetch(`http://127.0.0.1:${p}/api/audit?url=example.com`);
    expect(second.status).toBe(429);
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('returns 503 when the concurrency cap is reached', async () => {
    const slow: Fetcher = async (url, opts) => { await new Promise((r) => setTimeout(r, 50)); return fakeFetcher(url, opts); };
    const s = createAuditServer({ fetcher: slow, delayMs: 0, maxConcurrent: 1 });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = (s.address() as import('node:net').AddressInfo).port;
    const a = fetch(`http://127.0.0.1:${p}/api/audit?url=example.com/a`);
    await new Promise((r) => setTimeout(r, 5));
    const b = await fetch(`http://127.0.0.1:${p}/api/audit?url=example.com/b`);
    expect(b.status).toBe(503);
    await a;
    await new Promise<void>((r) => s.close(() => r()));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — `rateLimiter`/`maxConcurrent` options don't exist; no 429/503 paths.

- [ ] **Step 3: Modify `src/server.ts`**

Change the imports and `ServerOptions`, and add the guards at the top of the `/api/audit` handler.

```ts
// src/server.ts — imports
import { publicFetch } from './safeFetch.js';
import { createRateLimiter, type RateLimiter } from './rateLimiter.js';
```

```ts
// src/server.ts — ServerOptions
export interface ServerOptions {
  fetcher?: Fetcher;
  delayMs?: number;
  /** Per-IP limiter. Defaults to 10 audits / 10 min. */
  rateLimiter?: RateLimiter;
  /** Max simultaneous audits. Default 4. */
  maxConcurrent?: number;
  /** Trust X-Forwarded-For (set true only behind a proxy you control). Default false. */
  trustProxy?: boolean;
}
```

```ts
// src/server.ts — inside createAuditServer, before createServer(...)
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
```

Then, at the very start of the `if (req.method === 'GET' && url.pathname === '/api/audit') {` block (before reading `?url=`):

```ts
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
```

Wrap the existing `runAudit` call so `inFlight` is incremented before it and decremented in a `finally`, and replace `opts.fetcher` in the `runAudit` call with the resolved `fetcher`:

```ts
      inFlight++;
      try {
        const result = await runAudit(target, { fetcher, delayMs: opts.delayMs, onProgress: (message) => send('progress', { message }) });
        send('result', { result, fixFirst: prioritize(result.dimensions).concat(prioritize(result.informational)), markdown: renderMarkdown(result) });
      } catch (err) {
        send('fatal', { error: err instanceof Error ? err.message : String(err) });
      } finally {
        inFlight--;
      }
      res.end();
      return;
```

- [ ] **Step 4: Run the server tests**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS (including the original SSE/UI/400/404 tests, which pass their own `fetcher` so they bypass the guard).

- [ ] **Step 5: Full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `No errors found`; all suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): default to guarded fetch, add per-IP rate limit + concurrency cap"
```

---

## Task 6: CLI `serve` — env config + `--local` escape hatch

The `serve` command reads env for production knobs and gains `--local` so a developer can still audit private/localhost targets from the CLI-hosted UI.

**Files:**
- Modify: `src/cli.ts`
- Test: manual (documented below) — the parsing is thin; env wiring is verified by the server tests.

- [ ] **Step 1: Modify the `serve` branch in `src/cli.ts`**

```ts
// src/cli.ts — replace the `if (args[0] === 'serve') { ... }` body
  if (args[0] === 'serve') {
    let port = Number(process.env.PORT) || 4173;
    const portIdx = args.indexOf('--port');
    if (portIdx !== -1) {
      port = Number(args[portIdx + 1]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write('error: --port requires a number 0-65535\n');
        return 2;
      }
    }
    const local = args.includes('--local');
    const { startServer } = await import('./server.js');
    const { createGuardedFetcher } = await import('./safeFetch.js');
    await startServer(port, {
      trustProxy: process.env.WILLAICITE_TRUST_PROXY === '1',
      maxConcurrent: Number(process.env.WILLAICITE_MAX_CONCURRENT) || undefined,
      // --local opts back into the permissive fetcher for auditing private/localhost targets.
      fetcher: local ? createGuardedFetcher({ policy: { blockPrivateHosts: false, allowedPorts: null } }) : undefined,
    });
    return new Promise<number>(() => undefined);
  }
```

Add the flags to the `USAGE` string:

```
  --port <n>    Port for the local web UI (default 4173, or $PORT)
  --local       Allow auditing private/localhost targets (disables SSRF guard; never use on a public server)
```

- [ ] **Step 2: Build + smoke-test both modes**

```bash
npm run build
# Guarded (public) mode: a private target must be refused
node dist/cli.js serve --port 4801 &
sleep 1
curl -s "http://127.0.0.1:4801/api/audit?url=http://127.0.0.1:4801/" | head -c 200   # expect a fatal/blocked SSE event
# Local mode: private target allowed
node dist/cli.js serve --port 4802 --local &
sleep 1
curl -s "http://127.0.0.1:4802/api/audit?url=http://127.0.0.1:4802/" | head -c 200   # expect an audit result
kill %1 %2 2>/dev/null
```
Expected: port 4801 streams a blocked/fatal event for the loopback target; port 4802 runs the audit.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): serve reads env config; --local escape hatch for private-target audits"
```

---

## Task 7: Docs — README security section + SECURITY.md

State the guarantees (and non-guarantees) plainly; a security feature the operator misconfigures is no feature.

**Files:**
- Modify: `README.md`
- Create: `SECURITY.md`

- [ ] **Step 1: Add a "Running it as a public service" section to `README.md`** (after "What it fetches (politely)")

```markdown
## Running it as a public service

`geo-audit serve` is safe to expose publicly **only** because the hosted path fetches through an SSRF-guarded transport:

- Only `http`/`https`, only ports 80/443.
- The destination hostname is resolved and **every** returned address is checked; anything loopback, private (RFC 1918), link-local (incl. `169.254.169.254` cloud metadata), CGNAT, or reserved is refused. IPv4-mapped/6to4/NAT64 IPv6 forms that embed a private v4 are decoded and re-checked.
- The socket is **pinned** to the validated IP, so a hostname that re-resolves to a private address between the check and the connection (DNS rebinding) cannot slip through. Redirects are followed manually and every hop is re-validated.
- Per-IP rate limit (default 10 audits / 10 min) and a global concurrency cap (default 4).

Environment:

| Var | Purpose | Default |
|---|---|---|
| `PORT` | Listen port | 4173 |
| `WILLAICITE_TRUST_PROXY` | Set `1` behind a proxy you control (reads `X-Forwarded-For`) | off |
| `WILLAICITE_MAX_CONCURRENT` | Max simultaneous audits | 4 |

`--local` disables the SSRF guard so you can audit `localhost`/private targets from the CLI. **Never pass `--local` on a public server.**
```

- [ ] **Step 2: Create `SECURITY.md`**

```markdown
# Security

## Threat model

`geo-audit serve`, when public, takes an attacker-controlled URL and fetches it server-side. Without mitigation that is a Server-Side Request Forgery primitive: an attacker points it at `http://169.254.169.254/…`, `http://localhost:6379/`, or an internal host and reads the response via the audit output.

## Mitigations (src/safeFetch.ts, src/ipRules.ts)

- **Scheme/port allow-list:** http/https, ports 80/443.
- **Address validation, fail-closed:** resolve all A/AAAA records; block loopback, RFC 1918 private, link-local, CGNAT, benchmarking, multicast, reserved, and unspecified. Unparseable → blocked. IPv6 embeddings of IPv4 (`::ffff:`, `2002::/16`, `64:ff9b::/96`) are decoded and re-checked.
- **DNS-rebinding resistant:** the connection is pinned to the validated IP via a custom `lookup`; the socket connects to exactly the address that was checked.
- **Redirect re-validation:** redirects are followed manually, max 4 hops, each hop re-validated.
- **Resource bounds:** whole-request timeout, streamed body capped at `maxBytes` (aborted, not buffered-then-sliced), per-IP rate limit, global concurrency cap.

## Not covered (operator's responsibility)

- Run the process as an unprivileged user with no access to an internal network you care about; network egress policy is defense-in-depth on top of the app guard.
- TLS termination, HSTS, and DDoS protection belong to the proxy (Caddy/Fly), not this process.
- The guard blocks by IP class, not by allow-list; it does not stop fetches of *public* URLs the operator might consider undesirable.

## Reporting

Email <security contact> — do not open a public issue for an unpatched vulnerability.
```

- [ ] **Step 3: Commit**

```bash
git add README.md SECURITY.md
git commit -m "docs: security section + SECURITY.md for the public-service path"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full green**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `No errors found`; every suite PASS (ipRules, safeFetch, rateLimiter, server, plus the pre-existing suites).

- [ ] **Step 2: Confirm zero runtime deps preserved**

Run: `node -e "const p=require('./package.json'); console.log(p.dependencies || 'none')"`
Expected: `none` (or absent). If a dependency was added, the zero-dep guarantee is broken — revert it.

- [ ] **Step 3: End-to-end guard proof (build + live)**

Run: build, `node dist/cli.js serve --port 4803 &`, then request `?url=http://169.254.169.254/latest/meta-data/` and confirm the SSE stream carries a blocked/fatal event, not metadata. Kill the server.

- [ ] **Step 4: Confirm CLI unchanged for public targets**

Run: `node dist/cli.js https://example.com --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).overallScore))"`
Expected: a numeric score (the permissive CLI path still works against public sites).

---

## Self-review notes

- **Spec coverage:** SSRF (Tasks 1–3), redirect re-validation (Task 3), DNS-rebinding pin (Task 3 `makeLookup`), port restriction (Tasks 2–3), rate limit (Task 4 + 5), concurrency cap (Task 5), CLI escape hatch (Task 6), docs (Task 7). All mapped.
- **CLI behavior preserved:** `politeFetch` is untouched; only `server.ts` swaps to `publicFetch`. Auditing `localhost:3000` from the CLI still works (Task 8 Step 4).
- **Type consistency:** `Fetcher`/`FetchResult`/`FetchOptions` imported from `fetcher.ts`; `FetchPolicy`, `GuardedFetcherOptions`, `RateLimiter`, `createRateLimiter`, `createGuardedFetcher`, `publicFetch` names are used identically across Tasks 2–6.
- **Known residual risks (documented in SECURITY.md, not code-fixable here):** network-egress policy is the operator's; the guard is IP-class-based, not a URL allow-list.

---

## Out of scope — follow-on plans to write next

1. **Astro landing + report UI** — marketing page, the audit form, shareable report permalinks (determinism makes results cacheable by content hash), keeping the existing paper/newspaper aesthetic. Separate plan; depends on nothing here.
2. **Fly.io + Caddy deployment** — Dockerfile (multi-stage, `node:24-slim`, non-root user), `fly.toml`, Caddy for TLS/HSTS, `WILLAICITE_TRUST_PROXY=1`, health check, log/metrics. Separate plan; depends on this one (deploys the guarded server).
