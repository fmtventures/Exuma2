/**
 * Domains, publishing and redirects.
 *
 * Connecting a custom domain is the step where a small business is most likely
 * to break its own website, and where a platform is most likely to be blamed.
 * The design principle throughout is that nothing destructive happens on a
 * guess: DNS is verified before a domain is served, certificates are checked
 * before a redirect is enforced, and a publish is a versioned artifact that can
 * be rolled back rather than an in-place overwrite.
 *
 * The specific traps handled here:
 *
 *  - **Enforcing HTTPS before a certificate exists** takes the site offline.
 *    The redirect is gated on issued certificates, not on the merchant's
 *    intent to have them.
 *  - **Domain takeover.** A domain pointed at the platform but never verified
 *    must not be servable, or whoever claims it first gets someone else's
 *    traffic. Verification is per-domain and re-checked.
 *  - **Redirect loops and chains.** A redirect map assembled by hand across a
 *    migration will contain both. They are detected at save time, since a
 *    loop discovered in production is an outage.
 */

import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { DomainId, SiteId, UserId } from '../core/ids.ts';

export type DomainStatus =
  | 'pending_dns' | 'verifying' | 'issuing_certificate' | 'active' | 'error' | 'disconnected';

export interface DnsRecord {
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT';
  name: string;
  value: string;
  ttl?: number;
}

export interface Domain {
  id: DomainId;
  siteId: SiteId;
  hostname: string;
  /** The domain the site canonicalises to; the rest redirect to it. */
  isPrimary: boolean;
  status: DomainStatus;
  /** Proves control before we will serve the name. */
  verificationToken: string;
  verifiedAt?: string;
  certificate?: {
    issuedAt: string;
    expiresAt: string;
    issuer: string;
  };
  /** Merchant intent; only acted on once a certificate exists. */
  forceHttps: boolean;
  /** apex → www or www → apex. */
  redirectTo?: string;
  lastCheckedAt?: string;
  lastError?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Hostname handling                                                   */
/* ------------------------------------------------------------------ */

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalise and validate a hostname a merchant typed.
 *
 * People paste `https://www.example.com/contact?utm=1` into a field labelled
 * "domain". Extracting the host rather than rejecting the input is the
 * difference between a support ticket and a working site.
 */
export function normalizeHostname(input: string): Result<string> {
  let raw = String(input).trim().toLowerCase();
  if (raw === '') return fail(err('VALIDATION_FAILED', 'enter a domain name'));

  // Strip scheme, credentials, path, query and port.
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  raw = raw.replace(/^[^@/]*@/, '');
  raw = raw.split(/[/?#]/)[0] ?? '';
  raw = raw.replace(/:\d+$/, '');
  raw = raw.replace(/\.$/, '');

  if (raw === '') return fail(err('VALIDATION_FAILED', 'that does not contain a domain name'));

  // Unicode domains are stored as entered but compared by their ASCII form,
  // or a homograph registers as a different string to the same name.
  let ascii = raw;
  try {
    ascii = new URL(`https://${raw}`).hostname;
  } catch {
    return fail(err('VALIDATION_FAILED', `"${input}" is not a usable domain name`));
  }

  const labels = ascii.split('.');
  if (labels.length < 2) {
    return fail(err('VALIDATION_FAILED', `"${ascii}" is missing a top-level domain`));
  }
  if (ascii.length > 253) {
    return fail(err('VALIDATION_FAILED', 'that domain name is too long'));
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      return fail(err('VALIDATION_FAILED', `"${label}" is not a valid part of a domain name`));
    }
  }
  // A bare IP is not a domain and cannot be certificated by the usual means.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ascii)) {
    return fail(err('VALIDATION_FAILED', 'connect a domain name rather than an IP address'));
  }
  return ok(ascii);
}

export function isApex(hostname: string): boolean {
  // Good enough for the DNS instructions we give; a full public-suffix list
  // would be needed to be exact about names like example.co.uk.
  const labels = hostname.split('.');
  if (labels.length === 2) return true;
  if (labels.length === 3 && /^(co|com|org|net|gov|ac)$/.test(labels[1] ?? '')) return true;
  return false;
}

/**
 * The records a merchant must create.
 *
 * An apex cannot hold a CNAME under RFC 1034, which is why apex and subdomain
 * get different instructions — telling everyone to "add a CNAME" produces a
 * zone their registrar silently refuses or, worse, accepts and breaks MX.
 */
export function requiredDnsRecords(
  domain: Pick<Domain, 'hostname' | 'verificationToken'>,
  target: { ipv4: string[]; ipv6?: string[]; cname: string },
): DnsRecord[] {
  const records: DnsRecord[] = [{
    type: 'TXT',
    name: `_sidelio-challenge.${domain.hostname}`,
    value: domain.verificationToken,
    ttl: 300,
  }];

  if (isApex(domain.hostname)) {
    for (const ip of target.ipv4) records.push({ type: 'A', name: domain.hostname, value: ip, ttl: 3600 });
    for (const ip of target.ipv6 ?? []) records.push({ type: 'AAAA', name: domain.hostname, value: ip, ttl: 3600 });
  } else {
    records.push({ type: 'CNAME', name: domain.hostname, value: target.cname, ttl: 3600 });
  }
  return records;
}

export interface DnsLookup {
  resolve(hostname: string, type: DnsRecord['type']): Promise<string[]>;
}

/**
 * Check whether a domain is pointed at us and proven to be ours to serve.
 *
 * Both halves are required. Pointing alone is not enough: a name aimed at the
 * platform but never verified must not be servable, or whoever claims it first
 * receives someone else's traffic.
 */
export async function checkDomain(
  domain: Domain,
  target: { ipv4: string[]; cname: string },
  dns: DnsLookup,
  now: Date,
): Promise<Domain> {
  const fail_ = (message: string): Domain =>
    ({ ...domain, status: 'error', lastError: message, lastCheckedAt: now.toISOString() });

  let txt: string[] = [];
  try {
    txt = await dns.resolve(`_sidelio-challenge.${domain.hostname}`, 'TXT');
  } catch {
    return fail_('the verification TXT record could not be found yet');
  }
  if (!txt.some((v) => v.trim().replace(/^"|"$/g, '') === domain.verificationToken)) {
    return fail_('the verification TXT record does not match — DNS may still be propagating');
  }

  let pointed = false;
  try {
    if (isApex(domain.hostname)) {
      const a = await dns.resolve(domain.hostname, 'A');
      pointed = a.some((ip) => target.ipv4.includes(ip));
    } else {
      const cname = await dns.resolve(domain.hostname, 'CNAME');
      pointed = cname.some((v) => v.replace(/\.$/, '') === target.cname.replace(/\.$/, ''));
    }
  } catch {
    return fail_('the domain does not resolve yet');
  }
  if (!pointed) return fail_('the domain does not point here yet');

  return {
    ...domain,
    status: domain.certificate ? 'active' : 'issuing_certificate',
    verifiedAt: domain.verifiedAt ?? now.toISOString(),
    lastCheckedAt: now.toISOString(),
    lastError: undefined,
  };
}

/**
 * Should HTTPS be enforced right now?
 *
 * Intent alone is not enough. Redirecting to https before a certificate exists
 * takes the site off the internet, and it is the merchant's customers who find
 * out first.
 */
export function shouldForceHttps(domain: Domain, now: Date): boolean {
  if (!domain.forceHttps) return false;
  if (!domain.certificate) return false;
  return Date.parse(domain.certificate.expiresAt) > now.getTime();
}

/** Certificates needing renewal, soonest first. */
export function certificatesDue(domains: Domain[], now: Date, withinDays = 30): Domain[] {
  const cutoff = now.getTime() + withinDays * 86400000;
  return domains
    .filter((d) => d.certificate && Date.parse(d.certificate.expiresAt) <= cutoff)
    .sort((a, b) => Date.parse(a.certificate!.expiresAt) - Date.parse(b.certificate!.expiresAt));
}

export function canServe(domain: Domain): boolean {
  return domain.status === 'active' && Boolean(domain.verifiedAt);
}

/* ------------------------------------------------------------------ */
/* Redirects                                                           */
/* ------------------------------------------------------------------ */

export interface Redirect {
  id: string;
  from: string;
  to: string;
  /** 301 is permanent and cached hard; 302 is reversible. */
  status: 301 | 302 | 307 | 308;
  /** Carry the incoming query string onto the target. */
  preserveQuery?: boolean;
  note?: string;
}

/** Normalise a path for comparison: leading slash, no trailing slash, no query. */
export function normalizeRedirectPath(input: string): string {
  let path = String(input).trim();
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  path = path.split('#')[0] ?? '';
  path = path.split('?')[0] ?? '';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
}

export interface RedirectProblem {
  kind: 'loop' | 'chain' | 'duplicate' | 'self';
  redirectIds: string[];
  message: string;
}

/**
 * Find loops, chains and duplicates in a redirect map.
 *
 * A redirect map assembled across a site migration reliably contains all
 * three. A loop is an outage; a chain costs a round trip per hop and dilutes
 * the link equity the migration existed to preserve.
 */
export function auditRedirects(redirects: Redirect[]): RedirectProblem[] {
  const problems: RedirectProblem[] = [];
  const byFrom = new Map<string, Redirect>();

  for (const redirect of redirects) {
    const from = normalizeRedirectPath(redirect.from);
    const to = normalizeRedirectPath(redirect.to);

    if (from === to) {
      problems.push({ kind: 'self', redirectIds: [redirect.id], message: `${from} redirects to itself` });
      continue;
    }
    const existing = byFrom.get(from);
    if (existing) {
      problems.push({
        kind: 'duplicate',
        redirectIds: [existing.id, redirect.id],
        message: `${from} has two rules; the first one wins and the second never fires`,
      });
      continue;
    }
    byFrom.set(from, redirect);
  }

  for (const [from, redirect] of byFrom) {
    const seen = [from];
    let cursor = normalizeRedirectPath(redirect.to);
    let hops = 0;

    while (byFrom.has(cursor) && hops < 25) {
      if (seen.includes(cursor)) {
        problems.push({
          kind: 'loop',
          redirectIds: [redirect.id],
          message: `${seen.join(' → ')} → ${cursor} is a loop and would leave visitors on an error page`,
        });
        break;
      }
      seen.push(cursor);
      cursor = normalizeRedirectPath(byFrom.get(cursor)!.to);
      hops++;
    }

    if (hops > 0 && !problems.some((p) => p.kind === 'loop' && p.redirectIds.includes(redirect.id))) {
      problems.push({
        kind: 'chain',
        redirectIds: [redirect.id],
        message: `${from} reaches ${cursor} after ${hops + 1} hops; point it straight there`,
      });
    }
  }

  return problems;
}

/** Collapse chains so every rule points at its final destination. */
export function flattenRedirects(redirects: Redirect[]): Redirect[] {
  const byFrom = new Map(redirects.map((r) => [normalizeRedirectPath(r.from), r]));
  return redirects.map((redirect) => {
    const seen = new Set([normalizeRedirectPath(redirect.from)]);
    let cursor = normalizeRedirectPath(redirect.to);
    let hops = 0;
    while (byFrom.has(cursor) && hops < 25) {
      if (seen.has(cursor)) return redirect; // a loop is left alone for a human
      seen.add(cursor);
      cursor = normalizeRedirectPath(byFrom.get(cursor)!.to);
      hops++;
    }
    return hops === 0 ? redirect : { ...redirect, to: cursor };
  });
}

export function matchRedirect(redirects: Redirect[], requestPath: string): Redirect | undefined {
  const path = normalizeRedirectPath(requestPath);
  return redirects.find((r) => normalizeRedirectPath(r.from) === path);
}

/* ------------------------------------------------------------------ */
/* Publishing                                                          */
/* ------------------------------------------------------------------ */

export interface PublishedVersion {
  id: string;
  siteId: SiteId;
  /** Monotonic per site, so "roll back to 41" is unambiguous. */
  number: number;
  /** Content hash of the built artifact. */
  digest: string;
  pageCount: number;
  publishedBy: UserId;
  publishedAt: string;
  note?: string;
  /** Set when a later version supersedes this one. */
  supersededAt?: string;
  rolledBackFrom?: number;
}

export interface PublishCheck {
  id: string;
  severity: 'blocking' | 'warning';
  message: string;
  fix?: string;
}

export interface PublishInput {
  siteId: SiteId;
  pageCount: number;
  digest: string;
  publishedBy: UserId;
  previous?: PublishedVersion;
  checks: PublishCheck[];
  now: Date;
  makeId: (prefix: string) => string;
  note?: string;
  /** Ship despite warnings — never despite blocking checks. */
  acknowledgeWarnings?: boolean;
}

/**
 * Publish a version.
 *
 * Blocking checks cannot be overridden. Warnings can, but only deliberately:
 * a publish flow that lets every check be dismissed with one button trains
 * people to dismiss the one that mattered.
 */
export function publish(input: PublishInput): Result<PublishedVersion, { blocking: PublishCheck[]; warnings: PublishCheck[] }> {
  const blocking = input.checks.filter((c) => c.severity === 'blocking');
  const warnings = input.checks.filter((c) => c.severity === 'warning');

  if (blocking.length > 0) return fail({ blocking, warnings });
  if (warnings.length > 0 && !input.acknowledgeWarnings) return fail({ blocking: [], warnings });

  if (input.previous && input.previous.digest === input.digest) {
    // Republishing identical content burns a version number and makes the
    // history useless for working out when something actually changed.
    return ok(input.previous);
  }

  return ok({
    id: input.makeId('ver'),
    siteId: input.siteId,
    number: (input.previous?.number ?? 0) + 1,
    digest: input.digest,
    pageCount: input.pageCount,
    publishedBy: input.publishedBy,
    publishedAt: input.now.toISOString(),
    ...(input.note ? { note: input.note } : {}),
  });
}

/**
 * Roll back by publishing the old artifact forward as a new version.
 *
 * History is never rewritten — a rollback that deletes the bad version hides
 * the incident from whoever investigates it later.
 */
export function rollback(
  to: PublishedVersion,
  current: PublishedVersion,
  by: UserId,
  now: Date,
  makeId: (prefix: string) => string,
): Result<PublishedVersion> {
  if (to.siteId !== current.siteId) {
    return fail(err('CROSS_TENANT_ACCESS', 'that version belongs to a different site'));
  }
  if (to.number >= current.number) {
    return fail(err('VALIDATION_FAILED', 'that version is not older than the one live now'));
  }
  return ok({
    id: makeId('ver'),
    siteId: current.siteId,
    number: current.number + 1,
    digest: to.digest,
    pageCount: to.pageCount,
    publishedBy: by,
    publishedAt: now.toISOString(),
    note: `Rolled back to version ${to.number}`,
    rolledBackFrom: current.number,
  });
}

/** robots.txt for a site, refusing everything while it is unpublished. */
export function robotsTxt(options: { origin: string; indexable: boolean; sitemap?: boolean }): string {
  if (!options.indexable) {
    // A staging site indexed by Google outranks the real one and is very hard
    // to undo, so the default is closed.
    return 'User-agent: *\nDisallow: /\n';
  }
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /cart',
    'Disallow: /checkout',
    'Disallow: /account',
    '',
    ...(options.sitemap === false ? [] : [`Sitemap: ${options.origin.replace(/\/$/, '')}/sitemap.xml`]),
    '',
  ].join('\n');
}
