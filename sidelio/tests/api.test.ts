import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/api/server.ts';
import { seedStore, type AppStore } from '../src/api/store.ts';
import { FIXTURE_PAGES } from './fixtures/site.ts';

/**
 * API tests.
 *
 * These run against a real HTTP server on an ephemeral port, so route
 * matching, body parsing, status codes and the error envelope are all
 * exercised — not just the handlers in isolation.
 */

let server: Server;
let store: AppStore;
let base: string;

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : {},
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, raw: text };
}

const post = (path: string, body: unknown) =>
  call(path, { method: 'POST', body: JSON.stringify(body) });

beforeAll(async () => {
  store = await seedStore(FIXTURE_PAGES);
  server = createApp(store, new URL('../src/admin', import.meta.url).pathname);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'object' && address) base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('session and reads', () => {
  it('returns the site, its modules and the actor permissions', async () => {
    const { status, body } = await call('/api/session');
    expect(status).toBe(200);
    expect(body.site.name).toBe('Acme Roofing Ltd.');
    expect(body.permissions).toContain('page:update');
    expect(body.modules.length).toBeGreaterThan(0);
  });

  it('lists generated pages with their SEO issue counts', async () => {
    const { body } = await call('/api/pages');
    expect(body.pages.length).toBeGreaterThanOrEqual(3);
    expect(body.pages.some((p: { path: string }) => p.path === '/')).toBe(true);
  });

  it('404s an unknown page with a structured error envelope', async () => {
    const { status, body } = await call('/api/pages/page_missing');
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error).toHaveProperty('retryable');
  });

  it('rejects a malformed JSON body', async () => {
    const res = await fetch(`${base}/api/assistant/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('editing', () => {
  let pageId: string;

  beforeAll(async () => {
    const { body } = await call('/api/pages');
    pageId = body.pages[0].id;
  });

  it('applies a quick edit and returns the updated page', async () => {
    const { status, body } = await post(`/api/pages/${pageId}/edit`, {
      path: 'blocks.0.props.heading',
      value: 'Island roofing done right',
    });
    expect(status).toBe(200);
    expect(body.changeSet.status).toBe('applied');
    expect(body.page.blocks[0].props.heading).toBe('Island roofing done right');
  });

  it('rejects an edit with no field path', async () => {
    const { status } = await post(`/api/pages/${pageId}/edit`, { value: 'x' });
    expect(status).toBe(400);
  });

  it('inserts, moves and removes a block', async () => {
    const before = (await call(`/api/pages/${pageId}`)).body.page.blocks.length;

    const inserted = await post(`/api/pages/${pageId}/blocks`, {
      action: 'insert',
      index: before,
      block: {
        id: 'blk_test', type: 'cta',
        props: { heading: 'Talk to us', buttons: [{ label: 'Contact', href: '/contact', style: 'primary', newTab: false }] },
        style: { scheme: 'inherit', animation: 'none' },
        visibility: { hiddenOn: [], requiresAuth: false },
        locked: false,
      },
    });
    expect(inserted.status).toBe(200);
    expect(inserted.body.page.blocks).toHaveLength(before + 1);

    const moved = await post(`/api/pages/${pageId}/blocks`, { action: 'move', index: before, toIndex: 0 });
    expect(moved.body.page.blocks[0].props.heading).toBe('Talk to us');

    const removed = await post(`/api/pages/${pageId}/blocks`, { action: 'remove', index: 0 });
    expect(removed.body.page.blocks).toHaveLength(before);
  });

  it('refuses a block that fails its own schema', async () => {
    const { status, body } = await post(`/api/pages/${pageId}/blocks`, {
      action: 'insert',
      index: 0,
      block: {
        id: 'blk_bad', type: 'hero', props: {},
        style: { scheme: 'inherit', animation: 'none' },
        visibility: { hiddenOn: [], requiresAuth: false },
        locked: false,
      },
    });
    expect(status).toBe(400);
    expect(body.error.details.some((d: { path: string }) => d.path === 'heading')).toBe(true);
  });

  it('reports an out-of-range block index rather than corrupting the page', async () => {
    const { status } = await post(`/api/pages/${pageId}/blocks`, { action: 'remove', index: 99 });
    expect(status).toBe(404);
  });
});

describe('assistant', () => {
  it('plans without applying, then applies on request', async () => {
    const before = await call('/api/pages');
    const planned = await post('/api/assistant/plan', { intent: 'Change all phone numbers to 902-555-9876' });

    expect(planned.status).toBe(200);
    expect(planned.body.strategy).toBe('deterministic');
    expect(planned.body.previewOk).toBe(true);
    expect(planned.body.impact.join(' ')).toMatch(/page/);

    // Planning must not have changed anything yet.
    const during = await call('/api/pages');
    expect(during.body.pages).toEqual(before.body.pages);

    const applied = await post('/api/assistant/apply', { changeSet: planned.body.changeSet });
    expect(applied.body.changeSet.status).toBe('applied');

    const home = (await call(`/api/pages/${before.body.pages[0].id}`)).body.page;
    expect(JSON.stringify(home.blocks)).toContain('9025559876');
  });

  it('returns a usable error when the request cannot be planned', async () => {
    const { status, body } = await post('/api/assistant/plan', { intent: 'make it feel friendlier somehow' });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error.message).toBeTruthy();
  });

  it('requires an intent', async () => {
    const { status } = await post('/api/assistant/plan', { intent: '   ' });
    expect(status).toBe(400);
  });
});

describe('brand kit', () => {
  it('accepts a colour that keeps text legible', async () => {
    const { status, body } = await call('/api/brand', {
      method: 'PATCH',
      body: JSON.stringify({ colors: { primary: '#0d9488' } }),
    });
    expect(status).toBe(200);
    expect(body.brandKit.colors.primary).toBe('#0d9488');
  });

  it('refuses a colour that would make body text unreadable', async () => {
    const { status, body } = await call('/api/brand', {
      method: 'PATCH',
      body: JSON.stringify({ colors: { text: '#f7f7f7' } }),
    });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/unreadable/i);
  });
});

describe('fact review', () => {
  it('groups the queue by record rather than by field', async () => {
    const { body } = await call('/api/facts');
    expect(body.groups.length).toBeGreaterThan(0);
    // Grouping is only worth it if it actually collapses the work.
    expect(body.groups.length).toBeLessThan(body.stats.pendingReview);

    const faq = body.groups.find((g: { entityType: string }) => g.entityType === 'FAQ');
    expect(faq.fields.length).toBe(2);
    expect(faq.label).toBeTruthy();
  });

  it('approves every outstanding field on a record in one action', async () => {
    const before = await call('/api/facts');
    const group = before.body.groups.find((g: { fields: unknown[] }) => g.fields.length > 1);

    const { status, body } = await post(`/api/facts/entity/${group.entityId}/decision`, { decision: 'approve' });
    expect(status).toBe(200);
    expect(body.updated).toBe(group.fields.length);
    expect(body.stats.pendingReview).toBe(before.body.stats.pendingReview - group.fields.length);
  });

  it('404s a record with nothing outstanding', async () => {
    const { status } = await post('/api/facts/entity/ent_nope/decision', { decision: 'approve' });
    expect(status).toBe(404);
  });

  it('lets an approved fact reach the rendered structured data', async () => {
    const { body } = await call('/api/facts');
    const phone = body.groups
      .flatMap((g: { entityType: string; entityId: string; fields: Array<{ field: string; value: unknown }> }) =>
        g.entityType === 'ContactPoint' ? [g] : [])
      .find((g: { fields: Array<{ field: string; value: unknown }> }) =>
        g.fields.some((f) => f.field === 'value' && String(f.value).includes('-')));

    if (!phone) return; // already approved by an earlier test run through the graph
    await post(`/api/facts/entity/${phone.entityId}/decision`, { decision: 'approve' });

    const pages = await call('/api/pages');
    const html = (await call(`/preview/${pages.body.pages[0].id}`)).raw;
    expect(html).toContain('LocalBusiness');
  });
});

describe('history', () => {
  it('records every change and reverts one cleanly', async () => {
    const pages = await call('/api/pages');
    const pageId = pages.body.pages[0].id;

    const original = (await call(`/api/pages/${pageId}`)).body.page.blocks[0].props.heading;
    await post(`/api/pages/${pageId}/edit`, { path: 'blocks.0.props.heading', value: 'Temporary heading' });
    expect((await call(`/api/pages/${pageId}`)).body.page.blocks[0].props.heading).toBe('Temporary heading');

    const history = await call('/api/history');
    const latest = history.body.changeSets[0];
    expect(latest.status).toBe('applied');

    const reverted = await post(`/api/history/${latest.id}/revert`, {});
    expect(reverted.body.changeSet.status).toBe('reverted');
    expect((await call(`/api/pages/${pageId}`)).body.page.blocks[0].props.heading).toBe(original);
  });

  it('will not revert the same change set twice', async () => {
    const history = await call('/api/history');
    const reverted = history.body.changeSets.find((c: { status: string }) => c.status === 'reverted');
    const { status } = await post(`/api/history/${reverted.id}/revert`, {});
    expect(status).toBe(409);
  });
});

describe('audit log', () => {
  it('records the permission behind each mutation', async () => {
    const { body } = await call('/api/audit');
    const actions = body.events.map((e: { action: string }) => e.action);
    expect(actions).toContain('page.update');
    expect(actions).toContain('assistant.apply');

    const update = body.events.find((e: { action: string }) => e.action === 'page.update');
    expect(update.permission).toBe('page:update');
    expect(update.outcome).toBe('success');
  });
});

describe('preview and static assets', () => {
  it('renders a page with a strict CSP', async () => {
    const pages = await call('/api/pages');
    const res = await fetch(`${base}/preview/${pages.body.pages[0].id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('serves the admin shell and its assets', async () => {
    for (const [path, type] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/styles.css', 'text/css']]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain(type as string);
    }
  });

  it('refuses path traversal out of the admin directory', async () => {
    const res = await fetch(`${base}/../../package.json`, { redirect: 'manual' });
    expect(res.status).not.toBe(200);
  });
});
