import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';
import { CRAWLER_UA_STRING } from './robots.ts';

/**
 * Fetch abstraction.
 *
 * The crawler never calls global `fetch` directly. Everything goes through
 * this interface so that tests run against fixtures, background workers can
 * swap in a rate-limited/proxied implementation, and self-hosted deployments
 * can enforce their own egress policy in one place.
 */

export interface FetchResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
  /** Milliseconds; feeds the technical audit's speed findings. */
  elapsedMs: number;
  bytes: number;
}

export interface Fetcher {
  get(url: string): Promise<Result<FetchResponse>>;
}

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Blocks SSRF into private ranges — the crawler only ever leaves the network. */
export function isPubliclyRoutable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  if (host === '0.0.0.0' || host === '[::1]' || host === '::1') return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;             // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;   // CGNAT
    if (a === 0 || a >= 224) return false;
  }
  if (host.startsWith('[fd') || host.startsWith('[fc')) return false; // ULA
  return true;
}

export class HttpFetcher implements Fetcher {
  constructor(private readonly opts: { timeoutMs?: number; maxBytes?: number } = {}) {}

  async get(url: string): Promise<Result<FetchResponse>> {
    if (!isPubliclyRoutable(url)) {
      return fail(err('SOURCE_UNREACHABLE', `refusing to fetch non-public address ${url}`, {
        userMessage: 'That address cannot be reached from Sidelio.',
      }));
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': CRAWLER_UA_STRING, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      });

      const declared = Number(res.headers.get('content-length') ?? '0');
      const limit = this.opts.maxBytes ?? MAX_BYTES;
      if (declared > limit) {
        return fail(err('PAYLOAD_TOO_LARGE', `${url} is ${declared} bytes`));
      }

      const body = await res.text();
      if (body.length > limit) {
        return fail(err('PAYLOAD_TOO_LARGE', `${url} exceeded ${limit} bytes`));
      }

      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });

      return ok({
        url: res.url || url,
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body,
        headers,
        elapsedMs: Date.now() - started,
        bytes: body.length,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      return fail(err('SOURCE_UNREACHABLE', aborted ? `${url} timed out` : `could not reach ${url}`, {
        userMessage: aborted
          ? 'That website took too long to respond.'
          : 'We could not reach that website. Check the address and try again.',
        retryable: true,
        cause,
      }));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fixture-backed fetcher used by tests and by the import dry-run mode. */
export class StaticFetcher implements Fetcher {
  constructor(private readonly pages: Record<string, { body: string; contentType?: string; status?: number }>) {}

  async get(url: string): Promise<Result<FetchResponse>> {
    const page = this.pages[url] ?? this.pages[url.replace(/\/$/, '')];
    if (!page) {
      return fail(err('SOURCE_UNREACHABLE', `no fixture for ${url}`));
    }
    return ok({
      url,
      status: page.status ?? 200,
      contentType: page.contentType ?? 'text/html; charset=utf-8',
      body: page.body,
      headers: {},
      elapsedMs: 5,
      bytes: page.body.length,
    });
  }
}
