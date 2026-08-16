import { err } from '../core/errors.ts';
import type { OrgId, SiteId, UserId } from '../core/ids.ts';
import { fail, ok, type Result } from '../core/result.ts';

/**
 * Import authorization.
 *
 * Smart Import is a migration tool, not a site cloner. Before any crawl runs,
 * the requesting user must attest — on the record — that they have the right
 * to migrate the source. The attestation names the exact hosts it covers,
 * is stored with the actor and timestamp, and is re-checked at crawl time for
 * every URL. There is deliberately no way to start a job without one.
 */

export type AttestationBasis =
  /** "This is my business's website." */
  | 'owner'
  /** "I manage this website on behalf of the owner." (agencies) */
  | 'authorized_agent'
  /** "I hold a licence covering this material." */
  | 'licensed'
  /** "This material is mine under another arrangement." — requires a note. */
  | 'other_permission';

export interface ImportAttestation {
  orgId: OrgId;
  siteId: SiteId;
  attestedBy: UserId;
  basis: AttestationBasis;
  /** Registrable hosts this attestation covers, lowercased, no port. */
  hosts: string[];
  /** Required when basis is `other_permission`. */
  note?: string;
  attestedAt: string;
  ip?: string;
  /** Exact wording shown to the user, retained for the record. */
  statementVersion: string;
}

export const ATTESTATION_STATEMENT_VERSION = '2026-08-01';

export const ATTESTATION_STATEMENT =
  'I confirm that I own, manage, license, or otherwise have permission to ' +
  'migrate the content at the source(s) listed above into Sidelio, and that ' +
  'doing so does not infringe anyone else\'s rights.';

export function normalizeHost(input: string): string | null {
  let raw = input.trim().toLowerCase();
  if (raw === '') return null;
  if (!raw.includes('://')) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function createAttestation(input: {
  orgId: OrgId;
  siteId: SiteId;
  attestedBy: UserId;
  basis: AttestationBasis;
  hosts: string[];
  note?: string;
  ip?: string;
  accepted: boolean;
}): Result<ImportAttestation> {
  if (!input.accepted) {
    return fail(err('IMPORT_NOT_AUTHORIZED', 'attestation was not accepted', {
      userMessage: 'You must confirm you have permission to import this website before we can continue.',
    }));
  }
  if (input.basis === 'other_permission' && !input.note?.trim()) {
    return fail(err('VALIDATION_FAILED', 'a note is required for "other permission"', {
      details: [{ path: 'note', message: 'Describe the permission you hold.' }],
    }));
  }

  const hosts: string[] = [];
  for (const h of input.hosts) {
    const norm = normalizeHost(h);
    if (!norm) {
      return fail(err('VALIDATION_FAILED', `"${h}" is not a valid website address`, {
        details: [{ path: 'hosts', message: `"${h}" is not a valid website address.` }],
      }));
    }
    if (!hosts.includes(norm)) hosts.push(norm);
  }
  if (hosts.length === 0) {
    return fail(err('VALIDATION_FAILED', 'at least one source host is required'));
  }

  return ok({
    orgId: input.orgId,
    siteId: input.siteId,
    attestedBy: input.attestedBy,
    basis: input.basis,
    hosts,
    ...(input.note ? { note: input.note } : {}),
    ...(input.ip ? { ip: input.ip } : {}),
    attestedAt: new Date().toISOString(),
    statementVersion: ATTESTATION_STATEMENT_VERSION,
  });
}

/**
 * Does this attestation cover a given URL? Subdomains of an attested host are
 * covered (blog.acme.ca under acme.ca); unrelated hosts are not, which stops a
 * crawl from wandering off-site into third-party content.
 */
export function covers(attestation: ImportAttestation, url: string): boolean {
  const host = normalizeHost(url);
  if (!host) return false;
  return attestation.hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

export function assertCovers(attestation: ImportAttestation, url: string): Result<true> {
  if (covers(attestation, url)) return ok(true);
  return fail(err('IMPORT_NOT_AUTHORIZED', `${url} is outside the attested sources`, {
    userMessage: 'That address is not covered by the permission you confirmed. Add it to the source list to continue.',
  }));
}

/**
 * An email address can *suggest* a website, and nothing more. It never implies
 * permission to read the mailbox — that requires a separate OAuth connection.
 */
export function suggestWebsiteFromEmail(email: string): { host: string; candidateUrls: string[] } | null {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = normalizeHost(email.slice(at + 1));
  if (!domain) return null;

  const FREE_MAIL = new Set([
    'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
    'live.com', 'aol.com', 'proton.me', 'protonmail.com', 'me.com', 'msn.com',
  ]);
  if (FREE_MAIL.has(domain)) return null;

  return {
    host: domain,
    candidateUrls: [`https://${domain}`, `https://www.${domain}`],
  };
}
