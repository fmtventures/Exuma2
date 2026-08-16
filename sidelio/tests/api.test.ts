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
  // Not every route returns JSON — /preview and /cdn serve HTML and bytes — so
  // the raw text is always available and parsing is best-effort.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
  let body: any = {};
  if (text && (res.headers.get('content-type') ?? '').includes('json')) {
    body = JSON.parse(text);
  }
  return { status: res.status, body, raw: text };
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

describe('media', () => {
  it('lists assets ingested from the import with provenance', async () => {
    const { body } = await call('/api/media');
    expect(body.assets.length).toBeGreaterThan(0);
    expect(body.ingest.stored).toBe(body.assets.length);

    const hero = body.assets.find((a: { width: number }) => a.width === 1600);
    expect(hero.height).toBe(900);
    expect(hero.rights.origin).toBe('import_crawl');
    expect(hero.rights.source).toMatch(/^https:\/\/acmeroofing\.ca\//);
  });

  it('blocks every imported asset from publishing until rights are confirmed', async () => {
    const { body } = await call('/api/media');
    expect(body.assets.every((a: { publishable: boolean }) => !a.publishable)).toBe(true);
    expect(body.assets[0].blockedReason).toMatch(/commercial use/i);
  });

  it('confirms rights, and only then is the asset publishable', async () => {
    const before = await call('/api/media');
    const id = before.body.assets[0].id;

    const after = await post(`/api/media/${id}/rights`, { approvedForCommercialUse: true });
    expect(after.status).toBe(200);
    expect(after.body.asset.publishable).toBe(true);

    // Recorded, because this is the action that lets an image reach a page.
    const audit = await call('/api/audit');
    expect(audit.body.events.some((e: { action: string }) => e.action === 'asset.rights_confirmed')).toBe(true);
  });

  it('serves the stored bytes with a nosniff header', async () => {
    const { body } = await call('/api/media');
    const res = await fetch(`${base}${body.assets[0].rawUrl}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^image\//);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('serves /cdn URLs and says the transform did not happen', async () => {
    const { body } = await call('/api/media');
    const detail = await call(`/api/media/${body.assets[0].id}`);
    expect(detail.body.derivatives.length).toBeGreaterThan(5);

    const pages = await call('/api/pages');
    const html = (await call(`/preview/${pages.body.pages[0].id}`)).raw;
    const src = /src="(\/cdn\/[^"]+)"/.exec(html.replace(/&amp;/g, '&'))?.[1];
    expect(src).toBeTruthy();

    const res = await fetch(`${base}${src}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sidelio-transform')).toMatch(/not-implemented/);
  });

  it('renders imported media through the responsive asset path', async () => {
    const pages = await call('/api/pages');
    const html = (await call(`/preview/${pages.body.pages[0].id}`)).raw;
    // The assetId branch produces srcset + explicit dimensions; the fallback
    // URL branch does not. This is what proves ingestion reached the renderer.
    expect(html).toContain('srcset=');
    expect(html).toContain('fetchpriority="high"');
  });

  it('saves alt text and clears the generated flag', async () => {
    const { body } = await call('/api/media');
    const id = body.assets[0].id;
    const res = await post(`/api/media/${id}/alt`, { altText: 'A finished roof in Charlottetown' });
    expect(res.body.asset.altText).toBe('A finished roof in Charlottetown');
    expect(res.body.asset.altTextGenerated).toBe(false);
  });

  it('validates a focal point', async () => {
    const { body } = await call('/api/media');
    const id = body.assets[0].id;
    expect((await post(`/api/media/${id}/focal`, { x: 0.5, y: 0.3 })).status).toBe(200);
    expect((await post(`/api/media/${id}/focal`, { x: 5, y: 0 })).status).toBe(400);
  });

  it('refuses to archive an asset still used on a page', async () => {
    const { body } = await call('/api/media');
    const inUse = body.assets.find((a: { usageCount: number }) => a.usageCount > 0);
    const res = await post(`/api/media/${inUse.id}/archive`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/used on/i);
  });

  it('searches by text and by structural filter', async () => {
    const all = await call('/api/media/search?q=');
    expect(all.body.assets.length).toBeGreaterThan(0);

    const named = await call('/api/media/search?q=hero');
    expect(named.body.assets.every((a: { filename: string }) => /hero/i.test(a.filename))).toBe(true);
  });

  it('reports that near-duplicate detection has not run', async () => {
    const { body } = await call('/api/media');
    // Being explicit matters: an empty duplicates list otherwise reads as
    // "no duplicates" when it means "perceptual hashing never ran".
    expect(body.perceptualHashing).toBe(false);
  });
});

describe('typography', () => {
  it('offers font stacks with no external dependency', async () => {
    const { body } = await call('/api/brand');
    expect(body.fontStacks.length).toBeGreaterThan(4);
    for (const f of body.fontStacks) {
      expect(f.stack).not.toMatch(/https?:|url\(/);
    }
  });

  it('applies a typography change across the rendered site', async () => {
    const res = await call('/api/brand', {
      method: 'PATCH',
      body: JSON.stringify({ typography: { headingFamily: 'Georgia, Cambria, serif', baseSizePx: 18 } }),
    });
    expect(res.status).toBe(200);
    expect(res.body.brandKit.typography.baseSizePx).toBe(18);

    const pages = await call('/api/pages');
    const html = (await call(`/preview/${pages.body.pages[0].id}`)).raw;
    expect(html).toContain('--sl-font-heading: Georgia, Cambria, serif');
  });

  it('refuses body text too small to read', async () => {
    const res = await call('/api/brand', {
      method: 'PATCH',
      body: JSON.stringify({ typography: { baseSizePx: 11 } }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/too small/i);
  });

  it('refuses crowded line height but warns on merely tight', async () => {
    expect((await call('/api/brand', {
      method: 'PATCH', body: JSON.stringify({ typography: { lineHeight: 1.1 } }),
    })).status).toBe(400);

    const warned = await call('/api/brand', {
      method: 'PATCH', body: JSON.stringify({ typography: { lineHeight: 1.4 } }),
    });
    expect(warned.status).toBe(200);
    expect(warned.body.typographyIssues.some((i: { field: string }) => i.field === 'lineHeight')).toBe(true);
  });

  it('rejects a request that changes nothing', async () => {
    expect((await call('/api/brand', { method: 'PATCH', body: JSON.stringify({}) })).status).toBe(400);
  });
});

describe('design library', () => {
  it('offers a gallery of distinct designs rendered with this site\'s content', async () => {
    const { body } = await call('/api/templates');
    expect(body.total).toBeGreaterThanOrEqual(12);
    expect(body.templates).toHaveLength(body.total);

    // Distinctness is the whole product claim, so it is asserted, not assumed.
    const palettes = new Set(body.templates.map((t: { palette: { primary: string } }) => t.palette.primary));
    expect(palettes.size).toBeGreaterThanOrEqual(body.total - 1);

    const grounds = new Set(body.templates.map((t: { palette: { background: string } }) => t.palette.background));
    expect(grounds.size).toBeGreaterThan(3);

    const typefaces = new Set(body.templates.map((t: { typeface: string }) => t.typeface));
    expect(typefaces.size).toBeGreaterThan(4);

    // Each preview is the real renderer over the real business, not a mockup.
    for (const t of body.templates) {
      expect(t.previewHtml).toContain('<!doctype html>');
      expect(t.previewHtml).toContain('Acme Roofing Ltd.');
      expect(t.tagline).toBeTruthy();
    }
  });

  it('spans at least ten distinct page layouts, not one recoloured', async () => {
    const { body } = await call('/api/templates');

    // The earlier library varied palette and type but shared a single
    // arrangement, so every design read as the same page. Layout coverage is
    // asserted directly rather than trusted.
    const layouts = new Set(body.templates.map((t: { layout: string }) => t.layout));
    expect(layouts.size).toBeGreaterThanOrEqual(10);
    expect(body.layouts.length).toBeGreaterThanOrEqual(10);

    for (const t of body.templates) {
      expect(t.layoutName, t.name).toBeTruthy();
      expect(t.layoutDescription, t.name).toBeTruthy();
      // The layout must reach the markup, not just the metadata.
      expect(t.previewHtml).toContain('sl-layout');
    }

    // Each layout ships only its own CSS.
    const sidebar = body.templates.find((t: { layout: string }) => t.layout === 'sidebar');
    expect(sidebar.previewHtml).toContain('sl-sidebar');
    expect(sidebar.previewHtml).not.toContain('.sl-magazine');
  });

  it('carries the layout and treatments onto the pages it generates', async () => {
    await post('/api/templates/clinic/apply', {});
    const pages = await call('/api/pages');
    const page = (await call(`/api/pages/${pages.body.pages[0].id}`)).body.page;
    expect(page.layout).toBe('sidebar');
    expect(page.treatments).toContain('reveal');

    const html = (await call(`/preview/${page.id}`)).raw;
    expect(html).toContain('class="sl-layout sl-sidebar sl-tr ');
    expect(html).toContain('sl-tr-reveal');
    // The treatment must bring its CSS, not just its class name.
    expect(html).toContain('@keyframes sl-rise');
    // …and only its own: Clinic does not use grain, so the texture must not
    // ship. (The print unwind names the grain selector in every sheet on
    // purpose, so assert on the payload rather than the selector.)
    expect(html).not.toContain('feTurbulence');
  });

  it('puts designs built for the detected industry first', async () => {
    const { body } = await call('/api/templates');
    expect(body.industry).toBe('trades');
    expect(body.templates[0].suitsThisBusiness).toBe(true);

    const firstMismatch = body.templates.findIndex((t: { suitsThisBusiness: boolean }) => !t.suitsThisBusiness);
    const laterMatch = body.templates
      .slice(firstMismatch)
      .some((t: { suitsThisBusiness: boolean }) => t.suitsThisBusiness);
    expect(laterMatch).toBe(false);
  });

  it('applies a design, swapping pages and brand kit, and undoes cleanly', async () => {
    const before = (await call('/api/brand')).body.brandKit;
    const applied = await post('/api/templates/terminal/apply', {});
    expect(applied.status).toBe(200);
    expect(applied.body.template).toBe('Terminal');

    const after = (await call('/api/brand')).body.brandKit;
    expect(after.colors.background).toBe('#0a0f0c');
    expect(after.typography.headingFamily).toMatch(/mono/i);
    expect(after.colors.primary).not.toBe(before.colors.primary);

    const history = await call('/api/history');
    const entry = history.body.changeSets[0];
    expect(entry.title).toMatch(/Terminal/);
    expect((await post(`/api/history/${entry.id}/revert`, {})).status).toBe(200);
  });

  it('404s an unknown design', async () => {
    expect((await post('/api/templates/not-a-design/apply', {})).status).toBe(404);
  });
});

describe('design concepts', () => {
  it('generates three distinct directions with previews', async () => {
    const { body } = await call('/api/concepts');
    expect(body.concepts.map((c: { direction: string }) => c.direction))
      .toEqual(['conservative', 'modern', 'bold']);

    for (const c of body.concepts) {
      expect(c.pageCount).toBeGreaterThan(0);
      expect(c.previewHtml).toContain('<!doctype html>');
    }

    // The directions must differ as *designs*, not just in hero height. An
    // earlier version varied layout flags while sharing one brand kit and
    // produced three identical pages, so each axis is asserted separately.
    const palettes = body.concepts.map((c: { palette: { primary: string } }) => c.palette.primary);
    expect(new Set(palettes).size).toBe(3);

    const grounds = body.concepts.map((c: { palette: { background: string } }) => c.palette.background);
    expect(new Set(grounds).size).toBeGreaterThan(1);

    const typefaces = body.concepts.map((c: { typeface: string }) => c.typeface);
    expect(new Set(typefaces).size).toBe(3);

    const structures = body.concepts.map((c: { pages: Array<{ blocks: string[] }> }) =>
      c.pages[0]?.blocks.join('>'));
    expect(new Set(structures).size).toBe(3);

    for (const c of body.concepts) expect(c.rationale).toBeTruthy();
  });

  it('adopts the direction\'s design system when applied, not just its pages', async () => {
    const before = (await call('/api/brand')).body.brandKit.colors.primary;
    await post('/api/concepts/apply', { direction: 'bold' });

    const after = (await call('/api/brand')).body.brandKit;
    expect(after.colors.primary).not.toBe(before);
    expect(after.colors.background).toBe('#111315');
    expect(after.typography.headingFamily).toMatch(/Helvetica/);

    // A dark ground must not also carry a dark per-block scheme: the renderer
    // inverts for that flag, so applying both paints dark text on dark.
    const pages = await call('/api/pages');
    const page = (await call(`/api/pages/${pages.body.pages[0].id}`)).body.page;
    expect(page.blocks.every((b: { style: { scheme: string } }) => b.style.scheme !== 'dark')).toBe(true);
  });

  it('applies a concept as a reversible change set', async () => {
    const before = await call('/api/pages');
    const applied = await post('/api/concepts/apply', { direction: 'bold' });
    expect(applied.status).toBe(200);
    expect(applied.body.changeSet.status).toBe('applied');

    const history = await call('/api/history');
    const entry = history.body.changeSets[0];
    expect(entry.title).toMatch(/bold/);
    expect(entry.warnings.some((w: { code: string }) => w.code === 'pages_replaced')).toBe(true);

    // And it undoes cleanly back to the previous page set.
    const reverted = await post(`/api/history/${entry.id}/revert`, {});
    expect(reverted.status).toBe(200);
    const after = await call('/api/pages');
    expect(after.body.pages.map((p: { path: string }) => p.path).sort())
      .toEqual(before.body.pages.map((p: { path: string }) => p.path).sort());
  });

  it('rejects an unknown direction', async () => {
    expect((await post('/api/concepts/apply', { direction: 'wild' })).status).toBe(400);
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
