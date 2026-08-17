import { newId, type FactId } from './ids.ts';

/**
 * Provenance and confidence.
 *
 * The specification's hard rule is: never silently present an uncertain
 * business fact as truth. This module makes that structurally impossible —
 * every value extracted by Smart Import or produced by AI is wrapped in a
 * `Fact`, and a Fact cannot reach a published page unless it has been
 * approved or clears the auto-approval bar for its source kind.
 */

export type SourceKind =
  | 'website_crawl'
  | 'sitemap'
  | 'wordpress_export'
  | 'structured_data'   // schema.org / JSON-LD found on the source site
  | 'csv'
  | 'json'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'image_ocr'
  | 'cloud_storage'
  | 'authorized_api'
  | 'user_input'        // typed by a human — highest trust
  | 'ai_inference'      // derived by a model — lowest trust
  | 'ai_generated';     // net-new content authored by a model

export interface SourceRef {
  kind: SourceKind;
  /** URL or file path the value came from. */
  locator: string;
  /** CSS selector, page number, cell reference — enough to re-find the value. */
  fragment?: string;
  retrievedAt: string;
  /** Hash of the raw source snippet, so we can detect upstream drift. */
  contentHash?: string;
}

export type ApprovalState =
  /** Extracted, not yet looked at by a human. */
  | 'pending'
  /** A human confirmed the value. */
  | 'approved'
  /** A human rejected it; keep for audit, never publish. */
  | 'rejected'
  /** High-trust source, auto-approved by policy. */
  | 'auto_approved'
  /** Model was unsure; must be resolved before publish. */
  | 'needs_review';

export interface Fact<T = unknown> {
  id: FactId;
  /** Dotted path into the knowledge graph, e.g. `business.phone`. */
  path: string;
  value: T;
  /** 0..1. See `confidenceFromSource` for how extractors should seed this. */
  confidence: number;
  source: SourceRef;
  approval: ApprovalState;
  /** Set when a human edits the extracted value. */
  editedValue?: T;
  editedBy?: string;
  editedAt?: string;
  /** Competing values seen for the same path, kept for the review UI. */
  alternatives?: Array<{ value: T; confidence: number; source: SourceRef }>;
  notes?: string;
}

/**
 * Confidence floor by source kind. Extractors may lower these based on
 * signal quality (e.g. a phone number found in a footer beats one found in
 * body prose) but must never raise `ai_inference` above the review bar.
 */
export const SOURCE_BASE_CONFIDENCE: Record<SourceKind, number> = {
  user_input: 1.0,
  structured_data: 0.95,
  authorized_api: 0.95,
  wordpress_export: 0.9,
  csv: 0.9,
  xlsx: 0.9,
  json: 0.9,
  sitemap: 0.85,
  website_crawl: 0.75,
  docx: 0.7,
  pdf: 0.65,
  cloud_storage: 0.65,
  image_ocr: 0.5,
  ai_inference: 0.4,
  ai_generated: 0.3,
};

/** Values at or above this confidence, from a trusted source, auto-approve. */
export const AUTO_APPROVE_THRESHOLD = 0.9;

/** Source kinds that may never auto-approve, whatever their score. */
export const NEVER_AUTO_APPROVE: readonly SourceKind[] = ['ai_inference', 'ai_generated', 'image_ocr'];

export function initialApproval(source: SourceKind, confidence: number): ApprovalState {
  if (source === 'user_input') return 'approved';
  if (NEVER_AUTO_APPROVE.includes(source)) return 'needs_review';
  if (confidence >= AUTO_APPROVE_THRESHOLD) return 'auto_approved';
  return 'pending';
}

export function makeFact<T>(
  path: string,
  value: T,
  source: SourceRef,
  opts: { confidence?: number; notes?: string } = {},
): Fact<T> {
  const confidence = clamp01(opts.confidence ?? SOURCE_BASE_CONFIDENCE[source.kind]);
  return {
    id: newId('fact') as FactId,
    path,
    value,
    confidence,
    source,
    approval: initialApproval(source.kind, confidence),
    ...(opts.notes ? { notes: opts.notes } : {}),
  };
}

/** The value that should actually be used — human edit wins over extraction. */
export function effectiveValue<T>(fact: Fact<T>): T {
  return fact.editedValue !== undefined ? fact.editedValue : fact.value;
}

/**
 * Publication gate. This is the single chokepoint the renderer and the
 * publisher both call; nothing uncertain reaches a live page without a human
 * having said yes.
 */
export function isPublishable(fact: Fact): boolean {
  if (fact.approval === 'rejected') return false;
  if (fact.approval === 'approved') return true;
  if (fact.approval === 'auto_approved') return true;
  // `pending` and `needs_review` are publishable only once a human edits them.
  return fact.editedValue !== undefined;
}

export function approve<T>(fact: Fact<T>, by: string, at = new Date().toISOString()): Fact<T> {
  return { ...fact, approval: 'approved', editedBy: by, editedAt: at };
}

export function reject<T>(fact: Fact<T>, by: string, at = new Date().toISOString()): Fact<T> {
  return { ...fact, approval: 'rejected', editedBy: by, editedAt: at };
}

export function editValue<T>(fact: Fact<T>, value: T, by: string, at = new Date().toISOString()): Fact<T> {
  return { ...fact, editedValue: value, editedBy: by, editedAt: at, approval: 'approved' };
}

/**
 * Merge a newly-seen value for a path into an existing fact. The stronger
 * observation wins the primary slot; the weaker one is retained as an
 * alternative so the review UI can show "we also saw…".
 */
export function mergeFact<T>(existing: Fact<T>, incoming: Fact<T>): Fact<T> {
  if (existing.editedValue !== undefined) {
    // Never override a human edit; just record the sighting.
    return withAlternative(existing, incoming);
  }
  if (incoming.confidence > existing.confidence) {
    return withAlternative({ ...incoming, id: existing.id }, existing);
  }
  return withAlternative(existing, incoming);
}

function withAlternative<T>(primary: Fact<T>, other: Fact<T>): Fact<T> {
  if (JSON.stringify(primary.value) === JSON.stringify(other.value)) {
    // Same value from two sources — corroboration raises confidence, capped
    // below certainty so corroborated guesses never masquerade as user input.
    return { ...primary, confidence: clamp01(Math.max(primary.confidence, other.confidence) + 0.05, 0.98) };
  }
  const alternatives = [...(primary.alternatives ?? []), { value: other.value, confidence: other.confidence, source: other.source }];
  const conflicted: Fact<T> = { ...primary, alternatives };
  // A genuine conflict always deserves human eyes.
  if (conflicted.approval === 'auto_approved') conflicted.approval = 'needs_review';
  return conflicted;
}

function clamp01(n: number, max = 1): number {
  return Math.min(max, Math.max(0, n));
}
