export const TOOL_UA = 'Mozilla/5.0 (compatible; geo-audit/1.3; +https://github.com/ryanportfolio/willaicite)';

/** Real GPTBot UA string, used only for the WAF/CDN differential check. */
export const GPTBOT_UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';

export interface FetchResult {
  ok: boolean;
  status: number | null;
  headers: Record<string, string>;
  body: string | null;
  finalUrl: string | null;
  error: string | null;
}

export interface FetchOptions {
  ua?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Skip reading the body (status/headers only). */
  discardBody?: boolean;
}

export type Fetcher = (url: string, opts?: FetchOptions) => Promise<FetchResult>;

/**
 * Single polite fetch: custom UA, hard timeout, size cap, never throws.
 */
export const politeFetch: Fetcher = async (url, opts = {}) => {
  const { ua = TOOL_UA, timeoutMs = 12_000, maxBytes = 3_000_000, discardBody = false } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      },
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    let body: string | null = null;
    if (!discardBody) {
      const buf = await res.arrayBuffer();
      const sliced = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
      body = new TextDecoder('utf-8', { fatal: false }).decode(sliced);
    } else {
      // Drain politely so the connection can be reused/closed cleanly.
      await res.arrayBuffer().catch(() => undefined);
    }
    return { ok: res.ok, status: res.status, headers, body, finalUrl: res.url || url, error: null };
  } catch (err) {
    const message = err instanceof Error ? (err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message) : String(err);
    return { ok: false, status: null, headers: {}, body: null, finalUrl: null, error: message };
  } finally {
    clearTimeout(timer);
  }
};

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
