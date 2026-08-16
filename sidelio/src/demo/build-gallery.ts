import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedStore } from '../api/store.ts';
import { FIXTURE_PAGES } from '../../tests/fixtures/site.ts';
import { generateSite } from '../generate/site-plan.ts';
import { TEMPLATES } from '../generate/templates.ts';
import { renderPage } from '../render/html.ts';
import { fillForPreview } from '../generate/sample-content.ts';
import { DEFAULT_BRAND_KIT } from '../design/brand-kit.ts';
import { layoutById } from '../render/layouts.ts';
import { TREATMENTS } from '../render/treatments.ts';

const store = await seedStore(FIXTURE_PAGES);
mkdirSync(resolve(process.cwd(), 'dist/gallery'), { recursive: true });

const cards = TEMPLATES.map((tpl) => {
  const kit = tpl.brand(DEFAULT_BRAND_KIT);
  const site = generateSite(store.site.id, store.graph, { mode: 'redesign', templateId: tpl.id, industry: 'trades' });
  const home = site.pages.find((p) => p.path === '/') ?? site.pages[0]!;
  const html = renderPage({
    page: fillForPreview(home, kit, { wantSections: tpl.homeSections, fillImages: true }),
    brandKit: kit, assets: store.assetMap(), origin: 'https://preview.local', preview: true,
  }, {
    // A preview iframe is 1760px tall, so a `100vh` hero fills the whole card
    // and the rest of the design never appears. Pin viewport-height heroes to
    // one realistic screen for the thumbnail only — the published page keeps
    // its full-viewport hero.
    head: '<style>.sl-block--hero{min-height:min(560px,var(--sl-hero-cap,560px))!important;height:auto!important}</style>',
  });
  return { tpl, kit, html };
});

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const body = cards.map(({ tpl, kit, html }, i) => `
<article class="card" data-layout="${tpl.layout}" data-tags="${tpl.tags.join(' ')}">
  <div class="frame"><iframe title="${esc(tpl.name)} preview" srcdoc="${esc(html)}" loading="lazy" scrolling="no"></iframe></div>
  <div class="meta">
    <div class="head"><h2>${esc(tpl.name)}</h2><span class="swatches">${['primary','accent','surface','text'].map((k) => `<i style="background:${(kit.colors as unknown as Record<string,string>)[k] ?? kit.colors.primary}"></i>`).join('')}</span></div>
    <p class="tag">${esc(tpl.tagline)}</p>
    <p class="spec"><b>${esc(layoutById(tpl.layout).name)}</b> layout · ${esc(kit.typography.headingFamily.split(',')[0]!.replace(/["']/g,''))}</p>
    <ul class="tr">${tpl.treatments.map((t) => `<li data-cat="${TREATMENTS[t].category}">${esc(TREATMENTS[t].name)}</li>`).join('')}</ul>
  </div>
</article>`).join('');

const doc = `<title>Sidelio Design Library</title>
<style>
:root{--bg:#fbfbfa;--fg:#16181d;--mut:#6b7280;--line:#e4e4e7;--card:#fff;--accent:#3730a3}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d0f13;--fg:#f2f3f5;--mut:#9ca3af;--line:#272a31;--card:#14171c;--accent:#a5b4fc}}
:root[data-theme=dark]{--bg:#0d0f13;--fg:#f2f3f5;--mut:#9ca3af;--line:#272a31;--card:#14171c;--accent:#a5b4fc}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:48px 32px 20px;max-width:1400px;margin:0 auto}
h1{font-size:clamp(1.9rem,4vw,3rem);letter-spacing:-.03em;margin:0 0 .3em}
.lede{color:var(--mut);max-width:70ch;margin:0 0 1.4em}
.filters{display:flex;gap:8px;flex-wrap:wrap;padding:0 32px 24px;max-width:1400px;margin:0 auto}
button{font:inherit;font-size:.85rem;padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:28px;padding:0 32px 64px;max-width:1400px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.frame{height:440px;overflow:hidden;border-bottom:1px solid var(--line);background:#fff;position:relative}
iframe{width:1440px;height:1760px;border:0;transform:scale(.3055);transform-origin:0 0;pointer-events:none}
.meta{padding:16px 18px 18px}
.head{display:flex;align-items:center;justify-content:space-between;gap:10px}
h2{font-size:1.12rem;margin:0;letter-spacing:-.01em}
.swatches{display:flex;gap:4px}
.swatches i{width:14px;height:14px;border-radius:4px;border:1px solid rgb(128 128 128/.35)}
.tag{color:var(--mut);font-size:.87rem;margin:.5em 0 .6em}
.spec{font-size:.8rem;color:var(--mut);margin:0 0 .7em}
.spec b{color:var(--fg)}
.tr{list-style:none;display:flex;flex-wrap:wrap;gap:5px;padding:0;margin:0}
.tr li{font-size:.71rem;padding:3px 8px;border-radius:5px;border:1px solid var(--line);color:var(--mut)}
.tr li[data-cat=motion]{border-color:#8b5cf680;color:#8b5cf6}
.tr li[data-cat=type]{border-color:#0ea5e980;color:#0ea5e9}
.tr li[data-cat=surface]{border-color:#f59e0b80;color:#b45309}
.tr li[data-cat=media]{border-color:#10b98180;color:#059669}
.tr li[data-cat=detail]{border-color:#ec489980;color:#db2777}
.card[hidden]{display:none}
@media (max-width:600px){.grid{grid-template-columns:1fr;padding:0 16px 48px}header,.filters{padding-inline:16px}}
</style>
<header>
  <h1>Design library</h1>
  <p class="lede">Twenty-six designs, thirteen structural layouts, thirty-one visual treatments. Every preview below is the <em>same business content</em> rendered through a different design system — palette, type pairing, arrangement, media handling, motion and detail. Sections the crawler found no data for are filled with clearly-marked sample content so the composition can be judged; artwork is abstract by design rather than fabricated photography.</p>
</header>
<div class="filters" id="f">
  <button aria-pressed="true" data-l="all">All layouts</button>
  ${[...new Set(TEMPLATES.map((t) => t.layout))].map((l) => `<button data-l="${l}">${layoutById(l).name}</button>`).join('')}
</div>
<div class="grid">${body}</div>
<script>
document.getElementById('f').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b)return;
  for(const x of document.querySelectorAll('#f button'))x.setAttribute('aria-pressed',String(x===b));
  const l=b.dataset.l;
  for(const c of document.querySelectorAll('.card'))c.hidden = l!=='all' && c.dataset.layout!==l;
});
</script>`;

const out = resolve(process.cwd(), 'dist/gallery/index.html');
writeFileSync(out, doc);
console.log(`${out}  ${(doc.length / 1024).toFixed(0)} KB  ${cards.length} designs`);
