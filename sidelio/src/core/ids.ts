/**
 * Branded identifier types.
 *
 * Every entity in Sidelio is addressed by a prefixed, sortable identifier so
 * that an id is self-describing in logs, URLs and audit records
 * (`site_01J9...`). Branding them at the type level stops an OrgId from being
 * passed where a SiteId is expected — the single most common source of
 * cross-tenant data leaks in multi-tenant systems.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrgId = Brand<string, 'OrgId'>;
export type SiteId = Brand<string, 'SiteId'>;
export type UserId = Brand<string, 'UserId'>;
export type PageId = Brand<string, 'PageId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type CollectionId = Brand<string, 'CollectionId'>;
export type RecordId = Brand<string, 'RecordId'>;
export type ImportJobId = Brand<string, 'ImportJobId'>;
export type ChangeSetId = Brand<string, 'ChangeSetId'>;
export type FactId = Brand<string, 'FactId'>;
export type EntityId = Brand<string, 'EntityId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type DomainId = Brand<string, 'DomainId'>;

export const ID_PREFIXES = {
  org: 'org',
  site: 'site',
  user: 'usr',
  page: 'page',
  asset: 'ast',
  collection: 'col',
  record: 'rec',
  importJob: 'imp',
  changeSet: 'chg',
  fact: 'fact',
  entity: 'ent',
  auditEvent: 'aud',
  domain: 'dom',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Monotonic, lexicographically sortable suffix (ULID-shaped: 48-bit timestamp
 * + 80 bits of randomness). We generate our own rather than pulling a
 * dependency because id generation must stay deterministic under test.
 */
export interface IdClock {
  now(): number;
  random(): number;
}

const systemClock: IdClock = { now: () => Date.now(), random: () => Math.random() };

function encode(value: number, length: number): string {
  let out = '';
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out = CROCKFORD[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

export function newId<K extends IdKind>(kind: K, clock: IdClock = systemClock): string {
  const time = encode(clock.now(), 10);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand += CROCKFORD[Math.floor(clock.random() * 32) % 32];
  }
  return `${ID_PREFIXES[kind]}_${time}${rand}`;
}

/** Narrow an untrusted string into a branded id, validating its prefix. */
export function parseId<K extends IdKind>(kind: K, raw: string): string | null {
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!raw.startsWith(prefix)) return null;
  const body = raw.slice(prefix.length);
  if (body.length !== 26) return null;
  for (const ch of body) {
    if (!CROCKFORD.includes(ch)) return null;
  }
  return raw;
}

/** Unsafe cast for boundaries where the id has already been validated. */
export function asId<T extends string>(raw: string): T {
  return raw as T;
}
