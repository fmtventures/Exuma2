import { newId, type AuditEventId, type OrgId, type SiteId, type UserId } from './ids.ts';
import type { Permission } from './permissions.ts';

/**
 * Audit log.
 *
 * Append-only. Every state-changing operation writes exactly one event, and
 * the event records the authorization decision that permitted it. Reads are
 * audited only for sensitive resources (form submissions, customer records,
 * integration secrets) to keep volume sane.
 */

export type AuditCategory =
  | 'auth' | 'tenancy' | 'content' | 'media' | 'import' | 'ai' | 'commerce'
  | 'integration' | 'domain' | 'billing' | 'security' | 'publish' | 'data_access';

export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditEvent {
  id: AuditEventId;
  orgId: OrgId;
  siteId?: SiteId;
  actorId: UserId | 'system' | 'automation';
  /** Present when platform staff acted through a support session. */
  onBehalfOf?: UserId;
  category: AuditCategory;
  /** Verb-noun, e.g. `page.publish`, `import.apply`, `role.change`. */
  action: string;
  outcome: AuditOutcome;
  permission?: Permission;
  targetType?: string;
  targetId?: string;
  /** Small, structured, PII-light context. Never store secrets here. */
  metadata: Record<string, string | number | boolean | null>;
  ip?: string;
  userAgent?: string;
  at: string;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

export interface AuditInput extends Omit<AuditEvent, 'id' | 'at' | 'metadata'> {
  metadata?: AuditEvent['metadata'];
}

/** Keys that must be scrubbed if a caller passes them into metadata. */
const REDACTED_KEYS = new Set([
  'password', 'token', 'secret', 'api_key', 'apikey', 'authorization',
  'access_token', 'refresh_token', 'client_secret', 'private_key', 'card',
]);

export function buildAuditEvent(input: AuditInput, at = new Date().toISOString()): AuditEvent {
  return {
    ...input,
    id: newId('auditEvent') as AuditEventId,
    metadata: scrub(input.metadata ?? {}),
    at,
  };
}

function scrub(meta: AuditEvent['metadata']): AuditEvent['metadata'] {
  const out: AuditEvent['metadata'] = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

/** In-memory sink — the reference implementation and the one tests use. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
  find(action: string): AuditEvent[] {
    return this.events.filter((e) => e.action === action);
  }
}

export class Auditor {
  private readonly sink: AuditSink;

  constructor(sink: AuditSink) {
    this.sink = sink;
  }

  async record(input: AuditInput): Promise<AuditEvent> {
    const event = buildAuditEvent(input);
    await this.sink.write(event);
    return event;
  }

  /** Convenience for the common "permission denied" path. */
  async denied(input: Omit<AuditInput, 'outcome'>): Promise<AuditEvent> {
    return this.record({ ...input, outcome: 'denied' });
  }
}
