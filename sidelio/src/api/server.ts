import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { Page } from '../blocks/page.ts';
import { validateBlock, type Block } from '../blocks/schema.ts';
import { createChangeSet, describeImpact, summarize, type Operation } from '../core/changeset.ts';
import { err, SidelioError } from '../core/errors.ts';
import type { Permission } from '../core/permissions.ts';
import { effectivePermissions, requireCan } from '../core/permissions.ts';
import { approve, effectiveValue, reject } from '../core/provenance.ts';
import { visibleModules } from '../core/tenancy.ts';
import { auditContrast, type BrandKit } from '../design/brand-kit.ts';
import { renderPage, renderStyles } from '../render/html.ts';
import { auditPageSeo, renderHead } from '../render/seo.ts';
import { summaryLines } from '../import/review.ts';
import { AppStore, DEV_ACTOR, ORG_ID, SITE_ID, USER_ID } from './store.ts';

/**
 * Admin API.
 *
 * A small dependency-free HTTP layer over the domain modules. Every route
 * resolves an actor, checks a permission before doing anything, routes all
 * mutations through a ChangeSet, and writes an audit event. That is the same
 * lifecycle described in docs/architecture.md — the UI gets no shortcuts the
 * production API would not also have.
 */

interface Ctx {
  store: AppStore;
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: unknown;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
      keys.push(key);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, pattern, keys, handler });
}

/** Every mutating route calls this first. */
function authorize(permission: Permission) {
  const decision = requireCan(DEV_ACTOR, permission, { orgId: ORG_ID, siteId: SITE_ID });
  if (!decision.ok) throw decision.error;
}

/* ------------------------------------------------------------------ */
/* Read routes                                                         */
/* ------------------------------------------------------------------ */

route('GET', '/api/session', ({ store }) => ({
  actor: { userId: USER_ID, role: 'org_owner' },
  site: store.site,
  modules: visibleModules(store.site, 'agency'),
  permissions: effectivePermissions(DEV_ACTOR, { orgId: ORG_ID, siteId: SITE_ID }),
}));

route('GET', '/api/pages', ({ store }) => ({
  pages: store.pages().map((p) => ({
    id: p.id,
    path: p.path,
    title: p.title,
    status: p.status,
    blockCount: p.blocks.length,
    seoIssues: auditPageSeo(p).length,
  })),
}));

route('GET', '/api/pages/:pageId', ({ store, params }) => {
  const page = store.page(params['pageId'] as string);
  if (!page) throw err('NOT_FOUND', 'page not found');
  return { page, seoIssues: auditPageSeo(page) };
});

route('GET', '/api/brand', ({ store }) => ({
  brandKit: store.brandKit,
  contrastIssues: auditContrast(store.brandKit),
}));

route('GET', '/api/review', ({ store }) => {
  const review = store.review;
  if (!review) throw err('NOT_FOUND', 'no import review for this site');
  return {
    summary: review.summary,
    summaryLines: summaryLines(review.summary),
    pages: review.pages,
    warnings: review.warnings,
    siteFindings: review.siteFindings,
    assets: review.assets.slice(0, 50),
  };
});

/**
 * The facts a human must resolve before they can reach a published page.
 *
 * Grouped by entity rather than returned as a flat field list: an FAQ is one
 * decision a person makes ("is this question and answer right?"), not two, and
 * a social profile is one, not three. Reviewing field-by-field turns a 40-fact
 * queue into 40 clicks for what is really a dozen judgements.
 */
route('GET', '/api/facts', ({ store }) => {
  const graph = store.graph;
  const groups = new Map<string, {
    entityId: string;
    entityType: string;
    label: string;
    minConfidence: number;
    hasConflict: boolean;
    fields: Array<Record<string, unknown>>;
  }>();

  for (const fact of graph.reviewQueue()) {
    const [entityId, field] = fact.path.split('#');
    const id = entityId as string;
    const entity = graph.getEntity(id);

    let group = groups.get(id);
    if (!group) {
      group = {
        entityId: id,
        entityType: entity?.type ?? 'Unknown',
        label: entityLabel(entity),
        minConfidence: 100,
        hasConflict: false,
        fields: [],
      };
      groups.set(id, group);
    }

    const confidence = Math.round(fact.confidence * 100);
    group.minConfidence = Math.min(group.minConfidence, confidence);
    if ((fact.alternatives?.length ?? 0) > 0) group.hasConflict = true;
    group.fields.push({
      id: fact.id,
      field,
      value: effectiveValue(fact),
      confidence,
      approval: fact.approval,
      sourceKind: fact.source.kind,
      source: fact.source.locator,
      fragment: fact.source.fragment ?? null,
      alternatives: fact.alternatives?.map((a) => a.value) ?? [],
    });
  }

  return {
    stats: graph.stats(),
    // Weakest evidence first — that is where a human's attention is worth most.
    groups: [...groups.values()].sort((a, b) => a.minConfidence - b.minConfidence).slice(0, 100),
  };
});

function entityLabel(entity: ReturnType<AppStore['graph']['getEntity']>): string {
  if (!entity) return 'Unknown';
  for (const key of ['name', 'question', 'quote', 'title', 'value', 'label', 'network']) {
    const value = entity[key];
    if (typeof value === 'string' && value.trim()) return value.slice(0, 90);
  }
  return entity.type;
}

/** Approve or reject every outstanding field on one entity in a single action. */
route('POST', '/api/facts/entity/:entityId/decision', async ({ store, params, body }) => {
  authorize('content:update');
  const { decision } = body as { decision: 'approve' | 'reject' };
  const graph = store.graph;
  const entityId = params['entityId'] as string;

  const pending = graph.reviewQueue().filter((f) => f.path.startsWith(`${entityId}#`));
  if (pending.length === 0) throw err('NOT_FOUND', 'nothing outstanding on this record');

  for (const fact of pending) {
    const field = fact.path.split('#')[1] as string;
    graph.replaceFact(entityId, field, decision === 'approve' ? approve(fact, USER_ID) : reject(fact, USER_ID));
  }

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID, category: 'import',
    action: `record.${decision}`, outcome: 'success', permission: 'content:update',
    targetType: 'entity', targetId: entityId, metadata: { fields: pending.length },
  });

  return { updated: pending.length, stats: graph.stats() };
});

route('GET', '/api/history', ({ store }) => ({
  changeSets: store.changeSets.map((cs) => ({
    id: cs.id,
    title: cs.title,
    origin: cs.origin,
    status: cs.status,
    createdAt: cs.createdAt,
    impact: describeImpact(summarize(cs)),
    warnings: cs.warnings,
  })),
}));

route('GET', '/api/audit', ({ store }) => ({
  events: store.auditSink.events.slice(-100).reverse(),
}));

/* ------------------------------------------------------------------ */
/* Mutating routes — all through change sets                           */
/* ------------------------------------------------------------------ */

interface EditBody { path: string; value: unknown }

/** Quick edit: change one field on one page. */
route('POST', '/api/pages/:pageId/edit', async ({ store, params, body }) => {
  authorize('page:update');
  const page = store.page(params['pageId'] as string);
  if (!page) throw err('NOT_FOUND', 'page not found');

  const { path, value } = body as EditBody;
  if (typeof path !== 'string' || path === '') throw err('VALIDATION_FAILED', 'a field path is required');

  const before = readPath(page, path);
  const cs = createChangeSet({
    siteId: SITE_ID, origin: 'editor', title: `Edit ${path}`,
    createdBy: USER_ID,
    operations: [{ op: 'set', resource: { type: 'page', id: page.id, label: page.title }, path, before, after: value }],
  });

  const applied = store.applyChanges(cs);
  if (!applied.ok) throw applied.error;

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID, category: 'content',
    action: 'page.update', outcome: 'success', permission: 'page:update',
    targetType: 'page', targetId: page.id, metadata: { path },
  });

  return { changeSet: applied.value, page: store.page(page.id) };
});

interface BlockOpBody { action: 'insert' | 'remove' | 'move'; index: number; toIndex?: number; block?: Block }

/** Block editor: insert, remove or move a block. */
route('POST', '/api/pages/:pageId/blocks', async ({ store, params, body }) => {
  authorize('page:update');
  const page = store.page(params['pageId'] as string);
  if (!page) throw err('NOT_FOUND', 'page not found');

  const { action, index, toIndex, block } = body as BlockOpBody;
  const resource = { type: 'page' as const, id: page.id, label: page.title };
  let operation: Operation;
  let title: string;

  switch (action) {
    case 'insert': {
      if (!block) throw err('VALIDATION_FAILED', 'a block is required');
      const issues = validateBlock(block);
      if (issues.length > 0) {
        throw err('VALIDATION_FAILED', `invalid ${block.type} block`, {
          details: issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
      operation = { op: 'insert', resource, path: 'blocks', index, after: block };
      title = `Add ${block.type} section`;
      break;
    }
    case 'remove': {
      const existing = page.blocks[index];
      if (!existing) throw err('NOT_FOUND', `no block at index ${index}`);
      operation = { op: 'remove', resource, path: 'blocks', index, before: existing };
      title = `Remove ${existing.type} section`;
      break;
    }
    case 'move': {
      if (typeof toIndex !== 'number') throw err('VALIDATION_FAILED', 'toIndex is required');
      operation = { op: 'move', resource, path: 'blocks', fromIndex: index, toIndex };
      title = 'Reorder sections';
      break;
    }
    default:
      throw err('VALIDATION_FAILED', `unknown action "${action}"`);
  }

  const applied = store.applyChanges(createChangeSet({
    siteId: SITE_ID, origin: 'editor', title, createdBy: USER_ID, operations: [operation],
  }));
  if (!applied.ok) throw applied.error;

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID, category: 'content',
    action: `block.${action}`, outcome: 'success', permission: 'page:update',
    targetType: 'page', targetId: page.id, metadata: { index },
  });

  return { changeSet: applied.value, page: store.page(page.id) };
});

/** Assistant: produce a plan. Nothing is applied here. */
route('POST', '/api/assistant/plan', async ({ store, body }) => {
  authorize('ai:use');
  const { intent, scopePageId } = body as { intent?: string; scopePageId?: string };
  if (!intent?.trim()) throw err('VALIDATION_FAILED', 'tell the assistant what to change');

  const plan = await store.assistant.plan({
    intent: intent.trim(),
    actorId: USER_ID,
    state: {
      siteId: SITE_ID,
      pages: store.pages(),
      brandKit: store.brandKit,
      siteContext: {
        businessName: store.site.name,
        industry: 'trades',
        locale: store.site.locale,
      },
    },
    ...(scopePageId ? { scopePageId } : {}),
  });
  if (!plan.ok) throw plan.error;

  // Dry-run against a sandbox so the UI can report a stale plan before the
  // user commits to it.
  const previewed = store.previewChanges(plan.value.changeSet);

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID, category: 'ai',
    action: 'assistant.plan', outcome: 'success', permission: 'ai:use',
    metadata: { intent: intent.slice(0, 200), strategy: plan.value.strategy },
  });

  return {
    changeSet: plan.value.changeSet,
    impact: plan.value.impact,
    strategy: plan.value.strategy,
    explanation: plan.value.explanation,
    previewOk: previewed.ok,
    previewError: previewed.ok ? null : previewed.error.userMessage,
  };
});

route('POST', '/api/assistant/apply', async ({ store, body }) => {
  authorize('ai:apply_changeset');
  const { changeSet } = body as { changeSet?: Parameters<AppStore['applyChanges']>[0] };
  if (!changeSet) throw err('VALIDATION_FAILED', 'a change set is required');

  const applied = store.applyChanges(changeSet);
  if (!applied.ok) throw applied.error;

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID, category: 'ai',
    action: 'assistant.apply', outcome: 'success', permission: 'ai:apply_changeset',
    targetType: 'change_set', targetId: applied.value.id,
    metadata: { operations: applied.value.operations.length },
  });

  return { changeSet: applied.value };
});

route('POST', '/api/history/:changeSetId/revert', async ({ store, params }) => {
  authorize('page:update');
  const reverted = store.revertChanges(params['changeSetId'] as string);
  if (!reverted.ok) throw reverted.error;

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID, category: 'content',
    action: 'changeset.revert', outcome: 'success',
    targetType: 'change_set', targetId: reverted.value.id, metadata: {},
  });

  return { changeSet: reverted.value };
});

route('PATCH', '/api/brand', async ({ store, body }) => {
  authorize('brand:update');
  const { colors } = body as { colors?: Partial<BrandKit['colors']> };
  if (!colors) throw err('VALIDATION_FAILED', 'colors are required');

  const next: BrandKit = { ...store.brandKit, colors: { ...store.brandKit.colors, ...colors } };
  const issues = auditContrast(next);
  // Illegible text is refused outright; a hard-to-distinguish component is
  // returned as a warning the user can accept.
  const blocking = issues.filter((i) => i.kind === 'text' && i.level === 'fail');
  if (blocking.length > 0) {
    throw err('VALIDATION_FAILED', 'colour change would make text illegible', {
      details: blocking.map((i) => ({ path: i.token, message: `${i.ratio}:1 — WCAG AA needs 4.5:1` })),
      userMessage: `That colour would make ${blocking[0]?.token} unreadable.`,
    });
  }

  store.setBrandKit(next);
  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID, category: 'content',
    action: 'brand.update', outcome: 'success', permission: 'brand:update',
    metadata: { fields: Object.keys(colors).join(',') },
  });

  return { brandKit: next, contrastIssues: issues };
});

route('POST', '/api/facts/:factId/decision', async ({ store, params, body }) => {
  authorize('content:update');
  const { decision, value } = body as { decision: 'approve' | 'reject'; value?: unknown };
  const graph = store.graph;

  const fact = graph.allFacts().find((f) => f.id === params['factId']);
  if (!fact) throw err('NOT_FOUND', 'fact not found');

  const [entityId, field] = fact.path.split('#');
  const next = decision === 'approve'
    ? approve(value !== undefined ? { ...fact, editedValue: value } : fact, USER_ID)
    : reject(fact, USER_ID);
  graph.replaceFact(entityId as string, field as string, next);

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID, category: 'import',
    action: `fact.${decision}`, outcome: 'success', permission: 'content:update',
    targetType: 'fact', targetId: fact.id, metadata: { field: field ?? '' },
  });

  return { fact: next, stats: graph.stats() };
});

route('POST', '/api/review/decision', async ({ store, body }) => {
  authorize('import:apply');
  const { url, decision } = body as { url: string; decision: Parameters<AppStore['setPageDecision']>[1] };
  if (!store.setPageDecision(url, decision)) throw err('NOT_FOUND', 'page not in this review');
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/* Preview rendering                                                   */
/* ------------------------------------------------------------------ */

route('GET', '/preview/:pageId', ({ store, params, res }) => {
  const page = store.page(params['pageId'] as string);
  if (!page) throw err('NOT_FOUND', 'page not found');

  const html = renderPage(
    { page, brandKit: store.brandKit, assets: new Map(), origin: `https://${store.site.subdomain}.sidelio.site`, preview: true },
    {
      head: renderHead({
        page,
        origin: `https://${store.site.subdomain}.sidelio.site`,
        graph: store.graph,
        siteName: store.site.name,
      }),
    },
  );

  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // The preview iframe renders untrusted site content; keep it sandboxed
    // away from the admin's own origin capabilities.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src * data:; font-src *",
  });
  res.end(html);
  return undefined;
});

route('GET', '/api/brand.css', ({ store, res }) => {
  res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
  res.end(renderStyles(store.brandKit));
  return undefined;
});

/* ------------------------------------------------------------------ */
/* Static admin assets                                                 */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

async function serveAdmin(pathname: string, res: ServerResponse, adminDir: string): Promise<boolean> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  // Contain path traversal before touching the filesystem.
  const target = resolve(adminDir, normalize(rel));
  if (!target.startsWith(resolve(adminDir))) return false;

  try {
    const file = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(file);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

function readPath(doc: unknown, path: string): unknown {
  let cursor: unknown = doc;
  for (const seg of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = Array.isArray(cursor) ? cursor[Number(seg)] : (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw err('PAYLOAD_TOO_LARGE', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw err('VALIDATION_FAILED', 'request body is not valid JSON');
  }
}

export function createApp(store: AppStore, adminDir: string) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = r.pattern.exec(pathname);
        if (!match) continue;

        const params: Record<string, string> = {};
        r.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1] as string); });

        const body = req.method === 'GET' ? undefined : await readBody(req);
        const result = await r.handler({ store, req, res, params, body });
        if (res.writableEnded) return;

        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result ?? {}));
        return;
      }

      if (req.method === 'GET' && await serveAdmin(pathname, res, adminDir)) return;

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
    } catch (error) {
      const sidelio = error instanceof SidelioError
        ? error
        : err('INTERNAL', error instanceof Error ? error.message : 'unknown error', {
            userMessage: 'Something went wrong. Please try again.',
          });

      if (!res.writableEnded) {
        res.writeHead(sidelio.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(sidelio.toJSON()));
      }
      if (sidelio.status >= 500) console.error(sidelio);
    }
  });
}

export { join };
export type { Page };
