import { err } from './errors.ts';
import { newId, type ChangeSetId, type SiteId, type UserId } from './ids.ts';
import { fail, ok, type Result } from './result.ts';

/**
 * Change sets — the preview/apply spine of the whole product.
 *
 * Nothing in Sidelio mutates a site directly. The visual editor, the AI Site
 * Assistant, Smart Import and bulk admin actions all produce a ChangeSet,
 * which can be:
 *
 *   summarized  → "8 pages, 14 text fields, 6 images, 1 navigation item"
 *   previewed   → applied to a copy of the site for side-by-side review
 *   applied     → committed atomically, with an inverse stored for undo
 *   reverted    → by applying the stored inverse
 *
 * This is what makes large AI edits safe: the user always sees the blast
 * radius before anything changes, and every change is reversible.
 */

export type ResourceType =
  | 'page' | 'block' | 'navigation' | 'collection' | 'record' | 'asset'
  | 'brand' | 'setting' | 'form' | 'redirect' | 'seo';

export interface ResourceRef {
  type: ResourceType;
  id: string;
  /** Human label for the preview UI, e.g. "Home" or "Services / Roofing". */
  label?: string;
}

export type Operation =
  | { op: 'set'; resource: ResourceRef; path: string; before: unknown; after: unknown }
  | { op: 'create'; resource: ResourceRef; after: unknown }
  | { op: 'delete'; resource: ResourceRef; before: unknown }
  | { op: 'insert'; resource: ResourceRef; path: string; index: number; after: unknown }
  | { op: 'remove'; resource: ResourceRef; path: string; index: number; before: unknown }
  | { op: 'move'; resource: ResourceRef; path: string; fromIndex: number; toIndex: number };

export type ChangeSetOrigin = 'editor' | 'ai_assistant' | 'import' | 'automation' | 'api' | 'bulk_admin';

export type ChangeSetStatus = 'draft' | 'previewed' | 'applied' | 'reverted' | 'discarded';

export interface ChangeSet {
  id: ChangeSetId;
  siteId: SiteId;
  origin: ChangeSetOrigin;
  /** The natural-language request, when the origin is the AI assistant. */
  intent?: string;
  title: string;
  operations: Operation[];
  status: ChangeSetStatus;
  createdBy: UserId | 'system';
  createdAt: string;
  appliedAt?: string;
  revertedAt?: string;
  /** Populated on apply so the change can be undone. */
  inverse?: Operation[];
  /** Non-blocking cautions surfaced before apply. */
  warnings: ChangeWarning[];
}

export interface ChangeWarning {
  severity: 'info' | 'warning' | 'blocking';
  code: string;
  message: string;
  resource?: ResourceRef;
}

export interface ChangeSummary {
  totalOperations: number;
  /** Counts keyed by resource type, e.g. `{ page: 8, asset: 6 }`. */
  byResourceType: Record<string, number>;
  byOperation: Record<string, number>;
  /** Distinct resources touched — what the "8 pages" number counts. */
  affectedResources: ResourceRef[];
  /** Field-level count, i.e. "14 text fields". */
  fieldsChanged: number;
  hasBlockingWarnings: boolean;
}

export function createChangeSet(input: {
  siteId: SiteId;
  origin: ChangeSetOrigin;
  title: string;
  operations: Operation[];
  createdBy: UserId | 'system';
  intent?: string;
  warnings?: ChangeWarning[];
}): ChangeSet {
  return {
    id: newId('changeSet') as ChangeSetId,
    siteId: input.siteId,
    origin: input.origin,
    title: input.title,
    operations: input.operations,
    status: 'draft',
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    warnings: input.warnings ?? [],
    ...(input.intent ? { intent: input.intent } : {}),
  };
}

export function summarize(cs: ChangeSet): ChangeSummary {
  const byResourceType: Record<string, number> = {};
  const byOperation: Record<string, number> = {};
  const seen = new Map<string, ResourceRef>();
  let fieldsChanged = 0;

  for (const op of cs.operations) {
    byOperation[op.op] = (byOperation[op.op] ?? 0) + 1;
    const key = `${op.resource.type}:${op.resource.id}`;
    if (!seen.has(key)) {
      seen.set(key, op.resource);
      byResourceType[op.resource.type] = (byResourceType[op.resource.type] ?? 0) + 1;
    }
    if (op.op === 'set') fieldsChanged += 1;
  }

  return {
    totalOperations: cs.operations.length,
    byResourceType,
    byOperation,
    affectedResources: [...seen.values()],
    fieldsChanged,
    hasBlockingWarnings: cs.warnings.some((w) => w.severity === 'blocking'),
  };
}

/** Human-readable impact line for the PREVIEW / APPLY / CANCEL dialog. */
export function describeImpact(summary: ChangeSummary): string[] {
  const labels: Record<string, [string, string]> = {
    page: ['page', 'pages'],
    block: ['block', 'blocks'],
    navigation: ['navigation item', 'navigation items'],
    collection: ['collection', 'collections'],
    record: ['record', 'records'],
    asset: ['image', 'images'],
    brand: ['brand setting', 'brand settings'],
    setting: ['setting', 'settings'],
    form: ['form', 'forms'],
    redirect: ['redirect', 'redirects'],
    seo: ['SEO entry', 'SEO entries'],
  };
  const lines = Object.entries(summary.byResourceType).map(([type, count]) => {
    const pair = labels[type] ?? [type, `${type}s`];
    return `${count} ${count === 1 ? pair[0] : pair[1]}`;
  });
  if (summary.fieldsChanged > 0) {
    lines.push(`${summary.fieldsChanged} ${summary.fieldsChanged === 1 ? 'field' : 'fields'}`);
  }
  return lines;
}

/**
 * Minimal document store the change engine operates against. Backed by
 * Postgres in production and by a plain Map in tests; the engine itself never
 * knows which.
 */
export interface DocumentStore {
  get(ref: ResourceRef): unknown | undefined;
  put(ref: ResourceRef, doc: unknown): void;
  remove(ref: ResourceRef): void;
  /** Deep clone of the whole store — used to build a preview sandbox. */
  snapshot(): DocumentStore;
}

export class MemoryDocumentStore implements DocumentStore {
  private docs = new Map<string, unknown>();

  static from(entries: Array<[ResourceRef, unknown]>): MemoryDocumentStore {
    const store = new MemoryDocumentStore();
    for (const [ref, doc] of entries) store.put(ref, doc);
    return store;
  }

  private key(ref: ResourceRef) {
    return `${ref.type}:${ref.id}`;
  }

  get(ref: ResourceRef): unknown | undefined {
    return this.docs.get(this.key(ref));
  }

  put(ref: ResourceRef, doc: unknown): void {
    this.docs.set(this.key(ref), doc);
  }

  remove(ref: ResourceRef): void {
    this.docs.delete(this.key(ref));
  }

  snapshot(): MemoryDocumentStore {
    const copy = new MemoryDocumentStore();
    copy.docs = new Map(
      [...this.docs.entries()].map(([k, v]) => [k, structuredClone(v)]),
    );
    return copy;
  }

  entries(): Array<[string, unknown]> {
    return [...this.docs.entries()];
  }
}

/** Read a dotted path (`hero.title`, `blocks.2.text`) out of a document. */
export function readPath(doc: unknown, path: string): unknown {
  if (path === '') return doc;
  let cursor: unknown = doc;
  for (const segment of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx)) return undefined;
      cursor = cursor[idx];
    } else if (typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/** Immutably write a dotted path, creating intermediate objects as needed. */
export function writePath(doc: unknown, path: string, value: unknown): unknown {
  if (path === '') return value;
  const [head, ...rest] = path.split('.');
  const key = head as string;
  const childPath = rest.join('.');

  if (Array.isArray(doc)) {
    const idx = Number(key);
    if (!Number.isInteger(idx)) throw err('VALIDATION_FAILED', `array path segment "${key}" is not an index`);
    const next = [...doc];
    next[idx] = rest.length === 0 ? value : writePath(next[idx], childPath, value);
    return next;
  }

  const base = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  return {
    ...base,
    [key]: rest.length === 0 ? value : writePath(base[key], childPath, value),
  };
}

/** Compute the inverse of an operation so it can be undone. */
export function invert(op: Operation): Operation {
  switch (op.op) {
    case 'set':
      return { op: 'set', resource: op.resource, path: op.path, before: op.after, after: op.before };
    case 'create':
      return { op: 'delete', resource: op.resource, before: op.after };
    case 'delete':
      return { op: 'create', resource: op.resource, after: op.before };
    case 'insert':
      return { op: 'remove', resource: op.resource, path: op.path, index: op.index, before: op.after };
    case 'remove':
      return { op: 'insert', resource: op.resource, path: op.path, index: op.index, after: op.before };
    case 'move':
      return { op: 'move', resource: op.resource, path: op.path, fromIndex: op.toIndex, toIndex: op.fromIndex };
  }
}

export interface ApplyOptions {
  /**
   * Refuse to apply if a document changed since the change set was built.
   * Guards against two editors (or an editor and the AI) racing each other.
   */
  checkPreconditions?: boolean;
}

/**
 * Apply operations to a store. All-or-nothing: the store is only mutated once
 * every operation has been validated against a working copy.
 */
export function applyOperations(
  store: DocumentStore,
  operations: Operation[],
  options: ApplyOptions = {},
): Result<{ store: DocumentStore; inverse: Operation[] }> {
  const working = store.snapshot();
  const inverse: Operation[] = [];

  for (const op of operations) {
    const result = applyOne(working, op, options.checkPreconditions ?? true);
    if (!result.ok) return result;
    inverse.unshift(invert(op));
  }

  return ok({ store: working, inverse });
}

function applyOne(store: DocumentStore, op: Operation, check: boolean): Result<true> {
  switch (op.op) {
    case 'create': {
      if (check && store.get(op.resource) !== undefined) {
        return fail(err('CONFLICT', `${op.resource.type} ${op.resource.id} already exists`));
      }
      store.put(op.resource, structuredClone(op.after));
      return ok(true);
    }
    case 'delete': {
      const current = store.get(op.resource);
      if (current === undefined) {
        return fail(err('NOT_FOUND', `${op.resource.type} ${op.resource.id} not found`));
      }
      if (check && !deepEqual(current, op.before)) {
        return fail(staleError(op));
      }
      store.remove(op.resource);
      return ok(true);
    }
    case 'set': {
      const doc = store.get(op.resource);
      if (doc === undefined) {
        return fail(err('NOT_FOUND', `${op.resource.type} ${op.resource.id} not found`));
      }
      if (check && !deepEqual(readPath(doc, op.path), op.before)) {
        return fail(staleError(op));
      }
      store.put(op.resource, writePath(doc, op.path, structuredClone(op.after)));
      return ok(true);
    }
    case 'insert': {
      const doc = store.get(op.resource);
      if (doc === undefined) return fail(err('NOT_FOUND', `${op.resource.type} ${op.resource.id} not found`));
      const list = readPath(doc, op.path);
      if (!Array.isArray(list)) {
        return fail(err('VALIDATION_FAILED', `path "${op.path}" is not a list`));
      }
      if (op.index < 0 || op.index > list.length) {
        return fail(err('VALIDATION_FAILED', `insert index ${op.index} out of range`));
      }
      const next = [...list];
      next.splice(op.index, 0, structuredClone(op.after));
      store.put(op.resource, writePath(doc, op.path, next));
      return ok(true);
    }
    case 'remove': {
      const doc = store.get(op.resource);
      if (doc === undefined) return fail(err('NOT_FOUND', `${op.resource.type} ${op.resource.id} not found`));
      const list = readPath(doc, op.path);
      if (!Array.isArray(list)) return fail(err('VALIDATION_FAILED', `path "${op.path}" is not a list`));
      if (op.index < 0 || op.index >= list.length) {
        return fail(err('VALIDATION_FAILED', `remove index ${op.index} out of range`));
      }
      if (check && !deepEqual(list[op.index], op.before)) return fail(staleError(op));
      const next = [...list];
      next.splice(op.index, 1);
      store.put(op.resource, writePath(doc, op.path, next));
      return ok(true);
    }
    case 'move': {
      const doc = store.get(op.resource);
      if (doc === undefined) return fail(err('NOT_FOUND', `${op.resource.type} ${op.resource.id} not found`));
      const list = readPath(doc, op.path);
      if (!Array.isArray(list)) return fail(err('VALIDATION_FAILED', `path "${op.path}" is not a list`));
      if (op.fromIndex < 0 || op.fromIndex >= list.length || op.toIndex < 0 || op.toIndex >= list.length) {
        return fail(err('VALIDATION_FAILED', 'move index out of range'));
      }
      const next = [...list];
      const [moved] = next.splice(op.fromIndex, 1);
      next.splice(op.toIndex, 0, moved);
      store.put(op.resource, writePath(doc, op.path, next));
      return ok(true);
    }
  }
}

function staleError(op: Operation) {
  return err('PRECONDITION_FAILED', `${op.resource.type} ${op.resource.id} changed since this edit was prepared`, {
    userMessage: 'Someone else changed this content while you were working. Reload and try again.',
  });
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Build a preview without touching live data: returns the would-be store plus
 * the summary the UI renders in the WHAT WILL CHANGE panel.
 */
export function preview(
  store: DocumentStore,
  cs: ChangeSet,
): Result<{ store: DocumentStore; summary: ChangeSummary }> {
  const applied = applyOperations(store, cs.operations, { checkPreconditions: true });
  if (!applied.ok) return applied;
  return ok({ store: applied.value.store, summary: summarize(cs) });
}

/** Commit a change set, returning the updated store and the applied record. */
export function apply(
  store: DocumentStore,
  cs: ChangeSet,
  opts: ApplyOptions = {},
): Result<{ store: DocumentStore; changeSet: ChangeSet }> {
  if (cs.status === 'applied') {
    return fail(err('CONFLICT', 'change set has already been applied'));
  }
  if (cs.warnings.some((w) => w.severity === 'blocking')) {
    return fail(err('PRECONDITION_FAILED', 'change set has unresolved blocking warnings', {
      userMessage: 'Resolve the blocking issues before applying these changes.',
    }));
  }
  const applied = applyOperations(store, cs.operations, opts);
  if (!applied.ok) return applied;
  return ok({
    store: applied.value.store,
    changeSet: {
      ...cs,
      status: 'applied',
      appliedAt: new Date().toISOString(),
      inverse: applied.value.inverse,
    },
  });
}

/** Undo a previously applied change set. */
export function revert(store: DocumentStore, cs: ChangeSet): Result<{ store: DocumentStore; changeSet: ChangeSet }> {
  if (cs.status !== 'applied' || !cs.inverse) {
    return fail(err('CONFLICT', 'only an applied change set can be reverted'));
  }
  // Preconditions are relaxed on revert: the point is to get back to a known
  // state even if later edits touched neighbouring fields.
  const applied = applyOperations(store, cs.inverse, { checkPreconditions: false });
  if (!applied.ok) return applied;
  return ok({
    store: applied.value.store,
    changeSet: { ...cs, status: 'reverted', revertedAt: new Date().toISOString() },
  });
}
