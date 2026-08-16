/**
 * Static admin export: `npm run export:admin`
 *
 * Boots the real store, captures every GET response and every page preview,
 * and inlines them into one self-contained HTML file. The result opens with no
 * server, no network and no build step — useful for sharing a working view of
 * the admin with someone who cannot run the repo.
 *
 * It is deliberately read-only. Mutations need the change-set engine, and
 * shipping a fake one that pretends to save would be worse than saying so, so
 * the export intercepts writes and explains where to run the real thing.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_PAGES } from '../../tests/fixtures/site.ts';
import { createApp } from '../api/server.ts';
import { seedStore } from '../api/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const adminDir = resolve(here, '..', 'admin');

const store = await seedStore(FIXTURE_PAGES);
const server = createApp(store, adminDir);
await new Promise<void>((r) => server.listen(0, r));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const base = `http://127.0.0.1:${port}`;

const get = async (path: string) => (await fetch(`${base}${path}`)).json();
const getText = async (path: string) => (await fetch(`${base}${path}`)).text();

const pages = await get('/api/pages');
const data: Record<string, unknown> = {
  '/api/session': await get('/api/session'),
  '/api/pages': pages,
  '/api/brand': await get('/api/brand'),
  '/api/review': await get('/api/review'),
  '/api/facts': await get('/api/facts'),
  '/api/history': await get('/api/history'),
  '/api/audit': await get('/api/audit'),
};

const previews: Record<string, string> = {};
for (const page of (pages as { pages: Array<{ id: string }> }).pages) {
  data[`/api/pages/${page.id}`] = await get(`/api/pages/${page.id}`);
  previews[page.id] = await getText(`/preview/${page.id}`);
}

await new Promise<void>((r) => server.close(() => r()));

const html = readFileSync(join(adminDir, 'index.html'), 'utf8');
const css = readFileSync(join(adminDir, 'styles.css'), 'utf8');
const js = readFileSync(join(adminDir, 'app.js'), 'utf8');

/** `</script>` inside inlined data would close the tag early. */
const safeJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

const shim = `
const DATA = ${safeJson(data)};
const PREVIEWS = ${safeJson(previews)};

// Serve baked responses; refuse writes rather than faking them.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input).split('?')[0].replace(/^https?:\\/\\/[^/]+/, '');
  const method = (init && init.method) || 'GET';

  if (method !== 'GET') {
    document.dispatchEvent(new CustomEvent('sidelio:static-write'));
    return new Response(JSON.stringify({
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'This is a static snapshot — run "npm run dev" in the repo to make changes.',
        details: [], retryable: false,
      },
    }), { status: 501, headers: { 'content-type': 'application/json' } });
  }

  if (url in DATA) {
    return new Response(JSON.stringify(DATA[url]), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};

// The editor sets iframe.src to /preview/:id; swap in the captured HTML.
const applyPreview = (frame) => {
  const src = frame.getAttribute('src') || '';
  const match = /\\/preview\\/([^?]+)/.exec(src);
  if (!match) return;
  const captured = PREVIEWS[decodeURIComponent(match[1])];
  if (captured === undefined) return;
  frame.removeAttribute('src');
  frame.srcdoc = captured;
};

document.addEventListener('DOMContentLoaded', () => {
  const frame = document.getElementById('preview');
  if (!frame) return;
  new MutationObserver(() => applyPreview(frame))
    .observe(frame, { attributes: true, attributeFilter: ['src'] });
  applyPreview(frame);
});

document.addEventListener('sidelio:static-write', () => {
  const banner = document.getElementById('static-banner');
  if (banner) banner.classList.add('flash');
});
`;

const banner = `
<div id="static-banner" class="static-banner">
  <strong>Static snapshot.</strong>
  Every view holds real data captured from the running admin — pages, the fact queue,
  the import review, brand kit, history and audit log are all genuine output.
  Editing is disabled here; run <code>npm run dev</code> in the repo for the live version.
</div>
<style>
.static-banner {
  background: var(--panel-2); border-bottom: 1px solid var(--line);
  padding: .55rem 1rem; font-size: .85rem; color: var(--muted);
}
.static-banner strong { color: var(--text); }
.static-banner code { background: var(--bg); padding: .05rem .3rem; border-radius: 4px; }
.static-banner.flash { border-color: var(--warn); color: var(--text); }
</style>`;

const out = html
  // The artifact gallery lists pages by <title>; give it a product name.
  .replace('<title>Sidelio — Acme Roofing Ltd.</title>', '<title>Sidelio Admin</title>')
  .replace('<link rel="stylesheet" href="/styles.css">', `<style>\n${css}\n</style>`)
  .replace('<body>', `<body>\n${banner}`)
  .replace(
    '<script type="module" src="/app.js"></script>',
    `<script>${shim}</script>\n<script type="module">${js}</script>`,
  );

const target = resolve(process.cwd(), 'dist/demo/admin.html');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, out, 'utf8');

console.log(`  ${(out.length / 1024).toFixed(0)} KB written to ${target}`);
console.log(`  ${Object.keys(previews).length} page previews, ${Object.keys(data).length} API responses inlined`);
