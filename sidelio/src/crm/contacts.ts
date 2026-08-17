/**
 * Contacts, pipeline and consent.
 *
 * The CRM exists to answer one question well: what has this person done with
 * this business, and what should happen next. Everything here is built around
 * a timeline of events rather than a set of mutable fields, so "why is this
 * lead marked won?" always has an answer.
 *
 * Consent is treated as a legal record, not a preference toggle. Under GDPR
 * and CASL a business must be able to show what was agreed, when, and by what
 * means — so consent is append-only and a withdrawal never erases the grant
 * that preceded it. Deleting the evidence of consent leaves a business unable
 * to prove it ever had any.
 */

import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { SiteId, UserId } from '../core/ids.ts';

export type ConsentChannel = 'email_marketing' | 'sms_marketing' | 'phone' | 'post';
export type ConsentBasis = 'express' | 'implied' | 'legitimate_interest' | 'withdrawn';

export interface ConsentRecord {
  channel: ConsentChannel;
  basis: ConsentBasis;
  granted: boolean;
  /** The exact wording shown at the time. */
  text: string;
  source: string;
  at: string;
  ip?: string;
  /** Implied consent expires; express consent does not. */
  expiresAt?: string;
}

export interface Contact {
  id: string;
  siteId: SiteId;
  email?: string;
  phone?: string;
  name?: string;
  company?: string;
  tags: string[];
  /** Free-form, merchant-defined. */
  properties: Record<string, string>;
  /** Append-only. Never rewritten in place. */
  consent: ConsentRecord[];
  ownerId?: UserId;
  /** Set when the contact asks to be forgotten. */
  erasedAt?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
}

export type ActivityKind =
  | 'form_submitted' | 'booking_made' | 'booking_cancelled' | 'order_placed'
  | 'order_refunded' | 'event_registered' | 'email_sent' | 'email_opened'
  | 'note_added' | 'stage_changed' | 'call_logged' | 'consent_changed';

export interface Activity {
  id: string;
  siteId: SiteId;
  contactId: string;
  kind: ActivityKind;
  summary: string;
  /** Order, booking or submission this refers to. */
  referenceId?: string;
  actorId?: UserId;
  data?: Record<string, unknown>;
  at: string;
}

export interface PipelineStage {
  id: string;
  name: string;
  position: number;
  /** Reaching this stage ends the deal. */
  outcome?: 'won' | 'lost';
}

export interface Deal {
  id: string;
  siteId: SiteId;
  contactId: string;
  title: string;
  stageId: string;
  valueMinor?: number;
  currency?: string;
  ownerId?: UserId;
  source?: string;
  expectedCloseDate?: string;
  closedAt?: string;
  outcome?: 'won' | 'lost';
  lostReason?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Normalise an email for identity comparison only.
 *
 * Lower-cased and trimmed. Deliberately *not* stripping dots or plus-tags:
 * `a.b@gmail.com` and `ab@gmail.com` are the same Gmail inbox but different
 * addresses at most other providers, and treating them as one merges two real
 * customers into a single record — a data-protection incident, not a tidy-up.
 * The stored address always remains what the person actually typed.
 */
export function identityKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Digits only, for matching numbers written a dozen different ways. */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  // North American numbers are commonly written with and without the 1.
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export function findContact(
  contacts: Contact[],
  by: { email?: string; phone?: string },
): Contact | undefined {
  if (by.email) {
    const key = identityKey(by.email);
    const match = contacts.find((c) => c.email && identityKey(c.email) === key);
    if (match) return match;
  }
  if (by.phone) {
    const key = phoneKey(by.phone);
    if (key.length >= 7) {
      const match = contacts.find((c) => c.phone && phoneKey(c.phone) === key);
      if (match) return match;
    }
  }
  return undefined;
}

export interface UpsertInput {
  siteId: SiteId;
  email?: string;
  phone?: string;
  name?: string;
  company?: string;
  tags?: string[];
  properties?: Record<string, string>;
  consent?: ConsentRecord;
  now: Date;
  makeId: (prefix: string) => string;
}

/**
 * Create or update a contact from an inbound interaction.
 *
 * Existing values are never overwritten with nothing — a booking form that
 * collects no company name must not wipe the company recorded earlier. This is
 * the single most common way CRM data silently degrades.
 */
export function upsertContact(
  existing: Contact | undefined,
  input: UpsertInput,
): Result<Contact> {
  if (!input.email && !input.phone) {
    return fail(err('VALIDATION_FAILED', 'a contact needs an email address or a phone number'));
  }
  if (existing?.erasedAt) {
    return fail(err('CONFLICT', 'this contact was erased at their request and cannot be recreated from an old record'));
  }

  const base: Contact = existing ?? {
    id: input.makeId('con'),
    siteId: input.siteId,
    tags: [],
    properties: {},
    consent: [],
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
  };

  const merged: Contact = {
    ...base,
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.company ? { company: input.company } : {}),
    tags: [...new Set([...base.tags, ...(input.tags ?? [])])],
    properties: { ...base.properties, ...stripEmpty(input.properties ?? {}) },
    consent: input.consent ? [...base.consent, input.consent] : base.consent,
    updatedAt: input.now.toISOString(),
    lastActivityAt: input.now.toISOString(),
  };

  return ok(merged);
}

function stripEmpty(properties: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(properties).filter(([, v]) => v !== undefined && v !== ''));
}

/* ------------------------------------------------------------------ */
/* Consent                                                             */
/* ------------------------------------------------------------------ */

/**
 * May this contact be marketed to on this channel right now?
 *
 * Reads the latest record for the channel and honours expiry. Defaults to
 * *no* when nothing is recorded: the absence of a refusal is not permission,
 * and this function gates every marketing send.
 */
export function hasConsent(contact: Contact, channel: ConsentChannel, now: Date): boolean {
  if (contact.erasedAt) return false;
  const latest = [...contact.consent]
    .filter((c) => c.channel === channel)
    .sort((a, b) => a.at.localeCompare(b.at))
    .pop();
  if (!latest || !latest.granted) return false;
  if (latest.basis === 'withdrawn') return false;
  if (latest.expiresAt && Date.parse(latest.expiresAt) <= now.getTime()) return false;
  return true;
}

/**
 * Withdraw consent by appending, never by deleting.
 *
 * The record of the original grant is what proves the business was entitled to
 * contact them before the withdrawal. Erasing it makes the earlier sends
 * indefensible.
 */
export function withdrawConsent(
  contact: Contact,
  channel: ConsentChannel,
  source: string,
  now: Date,
): Contact {
  return {
    ...contact,
    consent: [...contact.consent, {
      channel, basis: 'withdrawn', granted: false,
      text: 'Consent withdrawn', source, at: now.toISOString(),
    }],
    updatedAt: now.toISOString(),
  };
}

/**
 * Erase personal data while keeping what the business must retain.
 *
 * A right-to-erasure request does not entitle a customer to delete the tax
 * record of a sale. Identifying fields are cleared and the contact tombstoned;
 * consent history is kept because it is the evidence of lawful processing, and
 * order records referencing the contact keep their own frozen copies.
 */
export function eraseContact(contact: Contact, now: Date): Contact {
  return {
    ...contact,
    email: undefined,
    phone: undefined,
    name: undefined,
    company: undefined,
    properties: {},
    tags: [],
    erasedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export function moveDeal(
  deal: Deal,
  toStage: PipelineStage,
  now: Date,
  lostReason?: string,
): Result<Deal> {
  if (deal.closedAt && !toStage.outcome) {
    return fail(err('CONFLICT', 'reopen this deal before moving it back into the pipeline'));
  }
  if (toStage.outcome === 'lost' && !lostReason?.trim()) {
    // A lost deal with no reason teaches the business nothing.
    return fail(err('VALIDATION_FAILED', 'a reason is required when marking a deal lost'));
  }
  return ok({
    ...deal,
    stageId: toStage.id,
    ...(toStage.outcome ? { outcome: toStage.outcome, closedAt: now.toISOString() } : {}),
    ...(lostReason ? { lostReason } : {}),
    updatedAt: now.toISOString(),
  });
}

export interface PipelineSummary {
  stageId: string;
  name: string;
  count: number;
  valueMinor: number;
}

export function summarisePipeline(stages: PipelineStage[], deals: Deal[]): PipelineSummary[] {
  return [...stages]
    .sort((a, b) => a.position - b.position)
    .map((stage) => {
      const inStage = deals.filter((d) => d.stageId === stage.id && !d.closedAt);
      return {
        stageId: stage.id,
        name: stage.name,
        count: inStage.length,
        valueMinor: inStage.reduce((n, d) => n + (d.valueMinor ?? 0), 0),
      };
    });
}

/** Deals with no activity for a while — the ones quietly going cold. */
export function stalledDeals(
  deals: Deal[],
  activities: Activity[],
  days: number,
  now: Date,
): Deal[] {
  const cutoff = now.getTime() - days * 86400000;
  const lastByContact = new Map<string, number>();
  for (const a of activities) {
    const at = Date.parse(a.at);
    const previous = lastByContact.get(a.contactId) ?? 0;
    if (at > previous) lastByContact.set(a.contactId, at);
  }
  return deals
    .filter((d) => !d.closedAt)
    .filter((d) => (lastByContact.get(d.contactId) ?? Date.parse(d.createdAt)) < cutoff)
    .sort((a, b) =>
      (lastByContact.get(a.contactId) ?? 0) - (lastByContact.get(b.contactId) ?? 0));
}

/** Timeline for one contact, newest first. */
export function timelineFor(activities: Activity[], contactId: string, limit = 100): Activity[] {
  return activities
    .filter((a) => a.contactId === contactId)
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

export function contactsToCsv(contacts: Contact[], now: Date): string {
  const header = ['Name', 'Email', 'Phone', 'Company', 'Tags', 'Email marketing consent', 'Created'];
  const cell = (value: string) => {
    let out = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(out)) out = `'${out}`;
    return /["\n\r,]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
  };
  const rows = contacts.map((c) => [
    c.name ?? '', c.email ?? '', c.phone ?? '', c.company ?? '',
    c.tags.join('; '),
    hasConsent(c, 'email_marketing', now) ? 'yes' : 'no',
    c.createdAt,
  ]);
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
