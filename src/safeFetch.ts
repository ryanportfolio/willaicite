import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { Fetcher, FetchResult, FetchOptions } from './fetcher.js';
import { TOOL_UA } from './fetcher.js';
import { isBlockedAddress } from './ipRules.js';

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

const DEFAULT_POLICY: FetchPolicy = {
  allowedPorts: new Set([80, 443]),
  blockPrivateHosts: true,
  maxRedirects: 4,
};

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

    return transport(url, fopts, policy, resolveHost);
  };
}

/**
 * A DNS lookup that resolves every address, rejects if any is blocked (fail
 * closed), and hands the socket a single validated IP — so the connection is
 * pinned to exactly the address that was checked (DNS-rebinding resistant).
 */
function makeLookup(
  resolveHost: (h: string) => Promise<{ address: string; family: number }[]>,
  blockPrivate: boolean,
) {
  return (hostname: string, options: unknown, cb: unknown): void => {
    // net/http calls lookup(hostname, options, callback); older callers pass (hostname, callback).
    const done = (typeof options === 'function' ? options : cb) as (
      err: Error | null,
      address?: string | { address: string; family: number }[],
      family?: number,
    ) => void;
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
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
      (err) => done(err instanceof Error ? err : new Error(String(err))),
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
    if (policy.allowedPorts && !policy.allowedPorts.has(portFor(url))) return fail(`blocked port: ${portFor(url)}`);

    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail(`timeout after ${timeoutMs}ms`);

    const result = await new Promise<FetchResult | { redirectTo: string }>((resolve) => {
      const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = requester(
        url,
        {
          method: 'GET',
          lookup,
          timeout: remaining,
          headers: {
            'user-agent': ua,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'accept-encoding': 'gzip, deflate, br',
          },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');

          if (status >= 300 && status < 400 && headers['location']) {
            res.resume(); // drain
            if (hop >= policy.maxRedirects) {
              resolve(fail('too many redirects'));
              return;
            }
            try {
              resolve({ redirectTo: new URL(headers['location'], url).href });
            } catch {
              resolve(fail(`invalid redirect location: ${headers['location']}`));
            }
            return;
          }

          if (discardBody) {
            res.resume();
            resolve({ ok: status >= 200 && status < 300, status, headers, body: null, finalUrl: url.href, error: null });
            return;
          }

          const enc = (headers['content-encoding'] || '').toLowerCase();
          const stream = enc.includes('br')
            ? res.pipe(createBrotliDecompress())
            : enc.includes('gzip')
              ? res.pipe(createGunzip())
              : enc.includes('deflate')
                ? res.pipe(createInflate())
                : res;

          const chunks: Buffer[] = [];
          let total = 0;
          let capped = false;
          const finishOk = () =>
            resolve({
              ok: status >= 200 && status < 300,
              status,
              headers,
              body: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)),
              finalUrl: url.href,
              error: null,
            });
          stream.on('data', (c: Buffer) => {
            if (capped) return;
            const room = maxBytes - total;
            chunks.push(c.length > room ? c.subarray(0, room) : c);
            total += Math.min(c.length, room);
            if (total >= maxBytes) {
              capped = true;
              req.destroy();
            }
          });
          stream.on('end', finishOk);
          stream.on('error', (e: Error) => (capped ? finishOk() : resolve(fail(e.message))));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(fail(`timeout after ${timeoutMs}ms`));
      });
      req.on('error', (e: Error) => resolve(fail(e.message)));
      req.end();
    });

    if ('redirectTo' in result) {
      try {
        url = new URL(result.redirectTo);
      } catch {
        return fail(`invalid redirect location: ${result.redirectTo}`);
      }
      continue;
    }
    return result;
  }
  return fail('too many redirects');
}

export const publicFetch: Fetcher = createGuardedFetcher();
