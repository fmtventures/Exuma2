/**
 * Sidelio admin client.
 *
 * Plain ES modules, no framework, no build step — the admin is a thin surface
 * over the API, and every edit it makes goes through the same ChangeSet path
 * the assistant and Smart Import use. There is no "just write it" back door.
 */

const state = {
  pages: [],
  currentPageId: null,
  page: null,
  plan: null,
  brandKit: null,
};

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : {},
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = data.error ?? { message: `Request failed (${res.status})`, details: [] };
    const detail = (error.details ?? []).map((d) => d.message).join(' ');
    throw new Error(detail ? `${error.message} ${detail}` : error.message);
  }
  return data;
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

const loaders = {};

function showView(name) {
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.classList.toggle('is-active', btn.dataset.view === name);
  }
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('is-active', view.dataset.view === name);
  }
  loaders[name]?.();
}

document.getElementById('nav-list').addEventListener('click', (event) => {
  const btn = event.target.closest('.nav-item');
  if (btn) showView(btn.dataset.view);
});

document.getElementById('btn-refresh').addEventListener('click', () => {
  loadSession();
  loadPages();
  refreshPreview();
});

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

async function loadSession() {
  const { site, modules } = await api('/api/session');
  document.getElementById('site-name').textContent = site.name;
  document.getElementById('site-domain').textContent = `${site.subdomain}.sidelio.site · ${site.status}`;
  document.getElementById('module-list').textContent = `${modules.length} modules enabled`;
  document.title = `Sidelio — ${site.name}`;
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

const BLOCK_TYPES = [
  'hero', 'text', 'text_image', 'services', 'team', 'testimonials', 'faq',
  'gallery', 'cta', 'stats', 'pricing', 'contact', 'map', 'form', 'banner',
  'logo_cloud', 'video', 'downloads',
];

const typeSelect = document.getElementById('add-block-type');
typeSelect.innerHTML = BLOCK_TYPES
  .map((t) => `<option value="${t}">${t.replace(/_/g, ' ')}</option>`).join('');

async function loadPages() {
  const { pages } = await api('/api/pages');
  state.pages = pages;
  if (!state.currentPageId || !pages.some((p) => p.id === state.currentPageId)) {
    state.currentPageId = pages[0]?.id ?? null;
  }

  document.getElementById('page-list').innerHTML = pages.map((p) => `
    <li>
      <button type="button" data-page="${esc(p.id)}" class="${p.id === state.currentPageId ? 'is-active' : ''}">
        ${esc(p.title)}
        <span class="path">${esc(p.path)} · ${p.blockCount} sections${p.seoIssues ? ` · ${p.seoIssues} SEO` : ''}</span>
      </button>
    </li>`).join('');

  if (state.currentPageId) await loadPage(state.currentPageId);
}

document.getElementById('page-list').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-page]');
  if (!btn) return;
  state.currentPageId = btn.dataset.page;
  loadPages();
});

/** Fields we expose for inline editing, per block type. */
const EDITABLE = {
  hero: [['heading', 'text'], ['subheading', 'text'], ['eyebrow', 'text']],
  text: [['heading', 'text'], ['body', 'textarea']],
  text_image: [['heading', 'text'], ['body', 'textarea']],
  services: [['heading', 'text'], ['intro', 'textarea']],
  team: [['heading', 'text']],
  testimonials: [['heading', 'text']],
  faq: [['heading', 'text']],
  gallery: [['heading', 'text']],
  cta: [['heading', 'text'], ['body', 'textarea']],
  stats: [['heading', 'text']],
  pricing: [['heading', 'text']],
  contact: [['heading', 'text']],
  form: [['heading', 'text'], ['submitLabel', 'text']],
  banner: [['message', 'text']],
  video: [['url', 'text'], ['caption', 'text']],
  downloads: [['heading', 'text']],
  logo_cloud: [['heading', 'text']],
  map: [],
};

async function loadPage(pageId) {
  const { page, seoIssues } = await api(`/api/pages/${encodeURIComponent(pageId)}`);
  state.page = page;
  document.getElementById('editing-title').textContent = `Sections — ${page.title}`;

  document.getElementById('block-list').innerHTML = page.blocks.map((block, i) => {
    const fields = (EDITABLE[block.type] ?? []).map(([key, kind]) => {
      const value = block.props[key] ?? '';
      const input = kind === 'textarea'
        ? `<textarea rows="3" data-index="${i}" data-key="${esc(key)}">${esc(value)}</textarea>`
        : `<input type="text" data-index="${i}" data-key="${esc(key)}" value="${esc(value)}">`;
      return `<div class="field"><label>${esc(key)}</label>${input}</div>`;
    }).join('');

    return `
      <li class="block">
        <div class="block-head">
          <span class="block-type">${i + 1}. ${esc(block.type.replace(/_/g, ' '))}</span>
          <span class="block-actions">
            <button type="button" class="btn btn-sm" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button type="button" class="btn btn-sm" data-move="${i}" data-dir="1" ${i === page.blocks.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            <button type="button" class="btn btn-sm btn-danger" data-remove="${i}" aria-label="Remove section">✕</button>
          </span>
        </div>
        ${fields || '<p class="muted small">No inline fields — edit this section in the block inspector.</p>'}
      </li>`;
  }).join('');

  document.getElementById('seo-issues').innerHTML = seoIssues.length
    ? `<h3>SEO</h3>${seoIssues.map((i) => `<div class="note ${esc(i.severity)}"><strong>${esc(i.message)}</strong><br><span class="muted small">${esc(i.fix)}</span></div>`).join('')}`
    : '<h3>SEO</h3><p class="muted small">No issues found on this page.</p>';

  refreshPreview();
}

/* Inline editing — commit on blur or Enter, never on every keystroke. */
const blockList = document.getElementById('block-list');

blockList.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-key]');
  if (!input) return;
  const path = `blocks.${input.dataset.index}.props.${input.dataset.key}`;
  try {
    const { page } = await api(`/api/pages/${encodeURIComponent(state.currentPageId)}/edit`, {
      method: 'POST',
      body: JSON.stringify({ path, value: input.value }),
    });
    state.page = page;
    refreshPreview();
    toast('Saved', 'ok');
  } catch (error) {
    toast(error.message, 'error');
    loadPage(state.currentPageId);
  }
});

blockList.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.tagName === 'INPUT') event.target.blur();
});

blockList.addEventListener('click', async (event) => {
  const move = event.target.closest('[data-move]');
  const remove = event.target.closest('[data-remove]');
  if (!move && !remove) return;

  try {
    if (move) {
      const index = Number(move.dataset.move);
      await blockOp({ action: 'move', index, toIndex: index + Number(move.dataset.dir) });
    } else {
      const index = Number(remove.dataset.remove);
      const type = state.page.blocks[index]?.type ?? 'section';
      if (!confirm(`Remove the ${type.replace(/_/g, ' ')} section? You can undo this from History.`)) return;
      await blockOp({ action: 'remove', index });
    }
  } catch (error) {
    toast(error.message, 'error');
  }
});

document.getElementById('btn-add-block').addEventListener('click', async () => {
  const type = typeSelect.value;
  try {
    await blockOp({
      action: 'insert',
      index: state.page?.blocks.length ?? 0,
      block: newBlock(type),
    });
    toast(`Added ${type.replace(/_/g, ' ')} section`, 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
});

async function blockOp(payload) {
  const { page } = await api(`/api/pages/${encodeURIComponent(state.currentPageId)}/blocks`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  state.page = page;
  await loadPages();
}

/** Defaults that satisfy each block's schema — the API validates regardless. */
function newBlock(type) {
  const props = {
    hero: { heading: 'New hero heading', overlay: 'none', layout: 'centered', height: 'medium', buttons: [] },
    text: { body: 'Add your content here.' },
    text_image: { body: 'Add your content here.', image: {}, imagePosition: 'right', buttons: [] },
    services: { heading: 'What we do', source: 'collection', items: [] },
    team: { heading: 'Meet the team', source: 'collection', members: [] },
    testimonials: { heading: 'What our customers say', source: 'collection', items: [] },
    faq: { heading: 'Frequently asked questions', source: 'collection', items: [] },
    gallery: { heading: 'Gallery', images: [] },
    cta: { heading: 'Ready to get started?', buttons: [{ label: 'Contact us', href: '/contact', style: 'primary', newTab: false }] },
    stats: { heading: 'By the numbers', items: [] },
    pricing: { heading: 'Pricing', tiers: [] },
    contact: { heading: 'Get in touch' },
    map: { zoom: 14, height: '400px' },
    form: { formId: 'contact', heading: 'Send us a message', submitLabel: 'Send' },
    banner: { message: 'Announcement' },
    logo_cloud: { logos: [] },
    video: { url: '' },
    downloads: { heading: 'Downloads', files: [] },
  }[type] ?? {};

  return {
    id: `blk_${Math.random().toString(36).slice(2, 12)}`,
    type,
    props,
    style: { scheme: 'inherit', animation: 'none' },
    visibility: { hiddenOn: [], requiresAuth: false },
    locked: false,
  };
}

/* Preview ----------------------------------------------------------- */

function refreshPreview() {
  if (!state.currentPageId) return;
  const frame = document.getElementById('preview');
  frame.src = `/preview/${encodeURIComponent(state.currentPageId)}?t=${Date.now()}`;
}

document.querySelector('.viewport-switch').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-width]');
  if (!btn) return;
  for (const b of document.querySelectorAll('[data-width]')) b.classList.toggle('is-active', b === btn);
  document.getElementById('preview').style.width = btn.dataset.width;
});

/* ------------------------------------------------------------------ */
/* Assistant                                                           */
/* ------------------------------------------------------------------ */

document.getElementById('assistant-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const intent = document.getElementById('assistant-input').value.trim();
  if (!intent) return;

  const scoped = document.getElementById('assistant-scope').checked;
  const result = document.getElementById('assistant-result');
  result.innerHTML = '<p class="muted small">Planning…</p>';

  try {
    const plan = await api('/api/assistant/plan', {
      method: 'POST',
      body: JSON.stringify({ intent, ...(scoped && state.currentPageId ? { scopePageId: state.currentPageId } : {}) }),
    });
    state.plan = plan.changeSet;
    renderPlan(plan);
  } catch (error) {
    state.plan = null;
    result.innerHTML = `<div class="note error"><strong>${esc(error.message)}</strong></div>`;
  }
});

function renderPlan(plan) {
  const blocking = plan.changeSet.warnings.filter((w) => w.severity === 'blocking');
  document.getElementById('assistant-result').innerHTML = `
    <div class="plan">
      <span class="strategy">${esc(plan.strategy)} plan</span>
      <p>${esc(plan.explanation)}</p>
      <h3>What will change</h3>
      <ul>${plan.impact.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
      ${plan.changeSet.warnings.map((w) => `<div class="note ${esc(w.severity)}">${esc(w.message)}</div>`).join('')}
      ${plan.previewOk ? '' : `<div class="note error">${esc(plan.previewError)}</div>`}
      <div class="actions">
        <button type="button" class="btn btn-primary" id="plan-apply" ${blocking.length || !plan.previewOk ? 'disabled' : ''}>Apply</button>
        <button type="button" class="btn" id="plan-cancel">Cancel</button>
      </div>
      ${blocking.length ? '<p class="muted small">Blocked until the issue above is resolved.</p>' : ''}
    </div>`;

  document.getElementById('plan-cancel').addEventListener('click', () => {
    state.plan = null;
    document.getElementById('assistant-result').innerHTML = '';
  });

  document.getElementById('plan-apply')?.addEventListener('click', async () => {
    try {
      await api('/api/assistant/apply', {
        method: 'POST',
        body: JSON.stringify({ changeSet: state.plan }),
      });
      state.plan = null;
      document.getElementById('assistant-result').innerHTML = '';
      document.getElementById('assistant-input').value = '';
      await loadPages();
      await loadBrand();
      toast('Change applied — undo from History', 'ok');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

for (const btn of document.querySelectorAll('.example')) {
  btn.addEventListener('click', () => {
    document.getElementById('assistant-input').value = btn.textContent.trim();
    document.getElementById('assistant-input').focus();
  });
}

/* ------------------------------------------------------------------ */
/* Import review                                                       */
/* ------------------------------------------------------------------ */

loaders.review = async () => {
  const review = await api('/api/review');

  document.getElementById('found-grid').innerHTML = review.summaryLines.map((line) => {
    const [count, ...rest] = line.split(' ');
    return `<div class="found"><strong>${esc(count)}</strong><span>${esc(rest.join(' '))}</span></div>`;
  }).join('');

  document.getElementById('review-warnings').innerHTML = review.warnings.map((w) => `
    <div class="note ${esc(w.severity)}">
      <strong>${esc(w.message)}</strong>
      ${w.affected.length ? `<br><code>${esc(w.affected.slice(0, 4).join(', '))}${w.affected.length > 4 ? ` +${w.affected.length - 4} more` : ''}</code>` : ''}
    </div>`).join('');

  const decisions = ['import', 'improve', 'replace', 'archive', 'ignore'];
  document.querySelector('#review-pages tbody').innerHTML = review.pages.map((p) => `
    <tr>
      <td>${esc(p.title)}<br><span class="muted small">${esc(p.url)}</span></td>
      <td>${esc(p.pageKind)}</td>
      <td>${p.wordCount}</td>
      <td>
        <select data-url="${esc(p.url)}">
          ${decisions.map((d) => `<option value="${d}" ${d === p.decision ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
      </td>
      <td class="muted small">${esc(p.reasons[0] ?? '')}</td>
    </tr>`).join('');
};

document.getElementById('review-pages').addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-url]');
  if (!select) return;
  try {
    await api('/api/review/decision', {
      method: 'POST',
      body: JSON.stringify({ url: select.dataset.url, decision: select.value }),
    });
    toast('Decision saved', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
});

/* ------------------------------------------------------------------ */
/* Fact queue                                                          */
/* ------------------------------------------------------------------ */

loaders.facts = async () => {
  const { stats, groups } = await api('/api/facts');

  document.getElementById('fact-stats').innerHTML = `
    <div><strong>${stats.totalFacts}</strong><span>facts extracted</span></div>
    <div><strong>${stats.publishable}</strong><span>cleared to publish</span></div>
    <div><strong>${stats.pendingReview}</strong><span>awaiting review</span></div>
    <div><strong>${groups.length}</strong><span>records to decide</span></div>`;

  const band = (c) => (c >= 85 ? 'high' : c >= 60 ? 'mid' : 'low');
  const show = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

  document.getElementById('fact-groups').innerHTML = groups.map((g) => `
    <article class="record ${g.hasConflict ? 'has-conflict' : ''}">
      <header>
        <div>
          <span class="record-type">${esc(g.entityType)}</span>
          <strong>${esc(g.label)}</strong>
          ${g.hasConflict ? '<span class="tag warn">conflicting values</span>' : ''}
        </div>
        <div class="record-actions">
          <span class="conf ${band(g.minConfidence)}">${g.minConfidence}%</span>
          <button type="button" class="btn btn-sm btn-primary" data-approve-entity="${esc(g.entityId)}">Approve record</button>
          <button type="button" class="btn btn-sm btn-danger" data-reject-entity="${esc(g.entityId)}">Reject</button>
        </div>
      </header>
      <dl class="record-fields">
        ${g.fields.map((f) => `
          <dt>${esc(f.field)}</dt>
          <dd>
            ${esc(show(f.value).slice(0, 220))}
            ${f.alternatives.length ? `<span class="muted small"> · also saw ${esc(show(f.alternatives).slice(0, 90))}</span>` : ''}
            <span class="muted small"> · ${f.confidence}% from ${esc(f.sourceKind)}${f.fragment ? ` (${esc(f.fragment)})` : ''}</span>
            <button type="button" class="link-btn" data-approve="${esc(f.id)}">approve just this</button>
          </dd>`).join('')}
      </dl>
    </article>`).join('') || '<p class="muted">Nothing awaiting review — every extracted detail has been decided.</p>';

  updateFactBadge(stats.pendingReview);
};

document.getElementById('fact-groups').addEventListener('click', async (event) => {
  const entityApprove = event.target.closest('[data-approve-entity]');
  const entityReject = event.target.closest('[data-reject-entity]');
  const fieldApprove = event.target.closest('[data-approve]');
  if (!entityApprove && !entityReject && !fieldApprove) return;

  try {
    if (fieldApprove) {
      await api(`/api/facts/${encodeURIComponent(fieldApprove.dataset.approve)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve' }),
      });
      toast('Field approved', 'ok');
    } else {
      const el = entityApprove ?? entityReject;
      const id = el.dataset.approveEntity ?? el.dataset.rejectEntity;
      const { updated } = await api(`/api/facts/entity/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: entityApprove ? 'approve' : 'reject' }),
      });
      toast(entityApprove
        ? `Approved ${updated} field${updated === 1 ? '' : 's'} — this record can now be published`
        : `Rejected ${updated} field${updated === 1 ? '' : 's'}`, 'ok');
    }
    await loaders.facts();
    await loadPages();
  } catch (error) {
    toast(error.message, 'error');
  }
});

function updateFactBadge(count) {
  const badge = document.getElementById('badge-facts');
  const pill = document.getElementById('fact-pill');
  badge.textContent = count > 0 ? String(count) : '';
  badge.hidden = count === 0;
  pill.hidden = count === 0;
  pill.textContent = `${count} facts awaiting review`;
}


/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

function assetCard(a) {
  const warn = !a.publishable ? '<span class="tag warn">rights not confirmed</span>' : '';
  const alt = !a.altText ? '<span class="tag">no alt text</span>' : '';
  return `
    <li class="media-item ${a.publishable ? '' : 'is-blocked'}">
      <button type="button" data-asset="${esc(a.id)}" class="media-thumb">
        <img src="${esc(a.rawUrl)}" alt="${esc(a.altText ?? '')}" loading="lazy" decoding="async">
      </button>
      <div class="media-meta">
        <strong>${esc(a.filename)}</strong>
        <span class="muted small">${a.width ?? '?'}\u00d7${a.height ?? '?'} · ${bytes(a.sizeBytes)} · used on ${a.usageCount}</span>
        <span class="media-tags">${warn}${alt}</span>
      </div>
    </li>`;
}

loaders.media = async () => {
  const data = await api('/api/media');
  state.media = data.assets;

  const blocked = data.assets.filter((a) => !a.publishable).length;
  document.getElementById('media-stats').innerHTML = `
    <div><strong>${data.assets.length}</strong><span>images</span></div>
    <div><strong>${blocked}</strong><span>rights not confirmed</span></div>
    <div><strong>${data.issues.filter((i) => i.code === 'missing_alt').length}</strong><span>missing alt text</span></div>
    <div><strong>${data.ingest?.bytesStored ? bytes(data.ingest.bytesStored) : '0 B'}</strong><span>stored</span></div>`;

  document.getElementById('media-duplicates').innerHTML = [
    data.duplicates.map((g) => `
      <div class="note warning">
        <strong>${esc(g.reason)}</strong><br>
        <span class="muted small">Keeping ${esc(g.keepId.slice(0, 12))}… of ${g.assetIds.length}</span>
      </div>`).join(''),
    data.perceptualHashing
      ? ''
      : `<p class="muted small">Exact duplicates only — near-duplicate detection needs an image decoder and has not run.</p>`,
  ].join('');

  renderMediaGrid(data.assets);
  updateMediaBadge(blocked);
};

function renderMediaGrid(assets) {
  document.getElementById('media-grid').innerHTML = assets.map(assetCard).join('')
    || '<li class="muted">No images matched.</li>';
  document.getElementById('media-count').textContent = `${assets.length} shown`;
}

let mediaSearchTimer;
document.getElementById('media-search').addEventListener('input', (event) => {
  clearTimeout(mediaSearchTimer);
  const q = event.target.value.trim();
  mediaSearchTimer = setTimeout(async () => {
    try {
      const { assets } = await api(`/api/media/search?q=${encodeURIComponent(q)}`);
      renderMediaGrid(assets);
    } catch (error) {
      toast(error.message, 'error');
    }
  }, 200);
});

document.getElementById('media-grid').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-asset]');
  if (btn) showAsset(btn.dataset.asset);
});

async function showAsset(id) {
  const panel = document.getElementById('media-detail');
  panel.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { asset, source, derivatives, derivativeError } = await api(`/api/media/${encodeURIComponent(id)}`);
    state.currentAsset = asset;

    panel.innerHTML = `
      <h3>${esc(asset.filename)}</h3>
      <img class="media-detail__preview" src="${esc(asset.rawUrl)}" alt="${esc(asset.altText ?? '')}">

      <dl class="kv">
        <dt>Dimensions</dt><dd>${asset.width ?? '?'}\u00d7${asset.height ?? '?'}</dd>
        <dt>Size</dt><dd>${bytes(asset.sizeBytes)}</dd>
        <dt>Type</dt><dd>${esc(asset.mimeType)}</dd>
        <dt>Used on</dt><dd>${asset.usageCount} page(s)</dd>
        <dt>Origin</dt><dd>${esc(asset.rights.origin)}</dd>
        ${source ? `<dt>Source</dt><dd class="break">${esc(source)}</dd>` : ''}
      </dl>

      <div class="field">
        <label for="asset-alt">Alt text</label>
        <input type="text" id="asset-alt" value="${esc(asset.altText ?? '')}" placeholder="Describe what the image shows">
      </div>

      <div class="note ${asset.publishable ? 'info' : 'blocking'}">
        <strong>${asset.publishable ? 'Cleared for use' : 'Cannot be published'}</strong><br>
        <span class="muted small">${esc(asset.blockedReason ?? 'Commercial use confirmed.')}</span>
        <div style="margin-top:.5rem">
          <label class="check">
            <input type="checkbox" id="asset-rights" ${asset.rights.approvedForCommercialUse ? 'checked' : ''}>
            I have the rights to use this image commercially
          </label>
        </div>
      </div>

      <h4>Generated sizes</h4>
      ${derivativeError
        ? `<p class="muted small">${esc(derivativeError)}</p>`
        : `<ul class="derivatives">${derivatives.slice(0, 8).map((d) => `
            <li>
              <strong>${esc(d.name.replace(/_/g, ' '))}</strong>
              <span class="muted small">${d.width}\u00d7${d.height} · crop ${d.crop.width}\u00d7${d.crop.height}${d.requiresUpscale ? ' · needs upscaling' : ''}</span>
            </li>`).join('')}</ul>
          <p class="muted small">Crops are computed now; the pixels are produced by a worker with an image decoder.</p>`}

      <button type="button" class="btn btn-sm btn-danger" id="asset-archive" ${asset.usageCount > 0 ? 'disabled title="Still used on a page"' : ''}>Archive</button>
    `;

    document.getElementById('asset-alt').addEventListener('change', async (e) => {
      try {
        await api(`/api/media/${encodeURIComponent(id)}/alt`, {
          method: 'POST', body: JSON.stringify({ altText: e.target.value }),
        });
        toast('Alt text saved', 'ok');
        loaders.media();
      } catch (error) { toast(error.message, 'error'); }
    });

    document.getElementById('asset-rights').addEventListener('change', async (e) => {
      try {
        await api(`/api/media/${encodeURIComponent(id)}/rights`, {
          method: 'POST', body: JSON.stringify({ approvedForCommercialUse: e.target.checked }),
        });
        toast(e.target.checked ? 'Rights confirmed — this image can now be published' : 'Rights withdrawn', 'ok');
        await loaders.media();
        showAsset(id);
      } catch (error) { toast(error.message, 'error'); }
    });

    document.getElementById('asset-archive').addEventListener('click', async () => {
      try {
        await api(`/api/media/${encodeURIComponent(id)}/archive`, { method: 'POST' });
        toast('Archived', 'ok');
        panel.innerHTML = '<p class="muted small">Select an image to see its details.</p>';
        loaders.media();
      } catch (error) { toast(error.message, 'error'); }
    });
  } catch (error) {
    panel.innerHTML = `<div class="note error">${esc(error.message)}</div>`;
  }
}

function updateMediaBadge(count) {
  const badge = document.getElementById('badge-media');
  badge.textContent = count > 0 ? String(count) : '';
  badge.hidden = count === 0;
}

/* ------------------------------------------------------------------ */
/* Design concepts                                                     */
/* ------------------------------------------------------------------ */

loaders.concepts = async () => {
  const grid = document.getElementById('concept-grid');
  grid.innerHTML = '<p class="muted">Generating three directions…</p>';
  try {
    const { concepts } = await api('/api/concepts');
    grid.innerHTML = concepts.map((c) => `
      <article class="concept">
        <header>
          <div>
            <h3>${esc(c.direction)}</h3>
            <span class="muted small">${esc(c.rationale)}</span>
          </div>
        </header>
        <div class="concept-swatches" aria-label="Palette and typeface">
          <span class="sw" style="background:${esc(c.palette.background)}" title="background"></span>
          <span class="sw" style="background:${esc(c.palette.primary)}" title="primary"></span>
          <span class="sw" style="background:${esc(c.palette.accent)}" title="accent"></span>
          <span class="sw" style="background:${esc(c.palette.text)}" title="text"></span>
          <span class="muted small">${esc(c.typeface)} · ${c.pageCount} pages</span>
        </div>
        <iframe class="concept-preview" title="${esc(c.direction)} concept preview" sandbox=""></iframe>
        <ul class="concept-pages">
          ${c.pages.map((p) => `<li><strong>${esc(p.path)}</strong> <span class="muted small">${esc(p.blocks.join(' → '))}</span></li>`).join('')}
        </ul>
        <button type="button" class="btn btn-primary btn-block" data-apply-concept="${esc(c.direction)}">Use this direction</button>
      </article>`).join('');

    // srcdoc rather than src: the preview HTML is already in hand, and a
    // sandboxed frame keeps it away from the admin's origin.
    grid.querySelectorAll('.concept-preview').forEach((frame, i) => {
      frame.srcdoc = concepts[i].previewHtml;
    });
  } catch (error) {
    grid.innerHTML = `<div class="note error">${esc(error.message)}</div>`;
  }
};

document.getElementById('concept-grid').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-apply-concept]');
  if (!btn) return;
  const direction = btn.dataset.applyConcept;
  if (!confirm(`Replace the current pages with the ${direction} concept? You can undo this from History.`)) return;

  try {
    await api('/api/concepts/apply', { method: 'POST', body: JSON.stringify({ direction }) });
    toast(`Applied the ${direction} concept — undo from History`, 'ok');
    await loadPages();
    showView('editor');
  } catch (error) {
    toast(error.message, 'error');
  }
});

/* ------------------------------------------------------------------ */
/* Brand kit                                                           */
/* ------------------------------------------------------------------ */

loaders.brand = loadBrand;

async function loadBrand() {
  const { brandKit, contrastIssues, typographyIssues, fontStacks } = await api('/api/brand');
  state.brandKit = brandKit;
  state.fontStacks = fontStacks;

  document.getElementById('brand-grid').innerHTML = Object.entries(brandKit.colors).map(([name, value]) => `
    <div class="swatch">
      <input type="color" value="${esc(value)}" data-color="${esc(name)}" aria-label="${esc(name)}">
      <div>
        <label for="">${esc(name)}</label>
        <code>${esc(value)}</code>
      </div>
    </div>`).join('');

  document.getElementById('contrast-issues').innerHTML = contrastIssues.length
    ? contrastIssues.map((i) => `
        <div class="note ${i.kind === 'text' && i.level === 'fail' ? 'blocking' : 'warning'}">
          <strong>${esc(i.token)} — ${i.ratio}:1</strong><br>
          <span class="muted small">${i.kind === 'text' ? 'WCAG AA needs 4.5:1 for text.' : 'WCAG needs 3:1 so the component is distinguishable.'}</span>
        </div>`).join('')
    : '<p class="muted small">All checked pairings pass WCAG AA.</p>';

  renderTypography(brandKit.typography, typographyIssues, fontStacks);
}

const TYPE_CONTROLS = [
  { key: 'headingFamily', label: 'Heading font', kind: 'font' },
  { key: 'bodyFamily', label: 'Body font', kind: 'font' },
  { key: 'baseSizePx', label: 'Base size', kind: 'range', min: 12, max: 26, step: 1, unit: 'px' },
  { key: 'ratio', label: 'Scale ratio', kind: 'range', min: 1.0, max: 1.9, step: 0.05, unit: '' },
  { key: 'lineHeight', label: 'Body line height', kind: 'range', min: 1.1, max: 2.1, step: 0.05, unit: '' },
  { key: 'headingLineHeight', label: 'Heading line height', kind: 'range', min: 0.9, max: 1.6, step: 0.05, unit: '' },
  { key: 'headingWeight', label: 'Heading weight', kind: 'range', min: 300, max: 900, step: 100, unit: '' },
  { key: 'bodyWeight', label: 'Body weight', kind: 'range', min: 300, max: 700, step: 100, unit: '' },
];

function renderTypography(t, issues, stacks) {
  document.getElementById('type-grid').innerHTML = TYPE_CONTROLS.map((c) => {
    if (c.kind === 'font') {
      const options = stacks.map((f) =>
        `<option value="${esc(f.stack)}" ${f.stack === t[c.key] ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
      // A stack set outside the curated list (e.g. by import) stays selectable.
      const known = stacks.some((f) => f.stack === t[c.key]);
      return `<div class="field">
          <label for="type-${c.key}">${esc(c.label)}</label>
          <select id="type-${c.key}" data-type-key="${c.key}">
            ${known ? '' : `<option value="${esc(t[c.key])}" selected>Current — ${esc(String(t[c.key]).split(',')[0])}</option>`}
            ${options}
          </select>
        </div>`;
    }
    return `<div class="field">
        <label for="type-${c.key}">${esc(c.label)} <span class="muted" id="type-${c.key}-out">${t[c.key]}${c.unit}</span></label>
        <input type="range" id="type-${c.key}" data-type-key="${c.key}"
          min="${c.min}" max="${c.max}" step="${c.step}" value="${t[c.key]}">
      </div>`;
  }).join('');

  document.getElementById('type-issues').innerHTML = issues.length
    ? issues.map((i) => `<div class="note ${i.severity === 'blocking' ? 'blocking' : 'warning'}">${esc(i.message)}</div>`).join('')
    : '<p class="muted small">Readable at the current settings.</p>';

  // Specimen rendered with the live tokens, so the effect is visible without
  // switching to the editor.
  const scale = (step) => `${(t.baseSizePx * t.ratio ** step) / 16}rem`;
  document.getElementById('type-specimen').innerHTML = `
    <div class="specimen" style="font-family:${esc(t.bodyFamily)};line-height:${t.lineHeight};font-weight:${t.bodyWeight}">
      <p style="font-family:${esc(t.headingFamily)};font-size:${scale(4)};font-weight:${t.headingWeight};line-height:${t.headingLineHeight};letter-spacing:${esc(t.letterSpacing)};margin:0 0 .4rem">
        Roofing you can rely on
      </p>
      <p style="font-family:${esc(t.headingFamily)};font-size:${scale(2)};font-weight:${t.headingWeight};line-height:${t.headingLineHeight};margin:0 0 .4rem">
        What we do
      </p>
      <p style="font-size:${scale(0)};margin:0">
        Acme Roofing has protected Island homes and businesses since 1998, from a single
        missing shingle to a full commercial re-roof.
      </p>
    </div>`;
}

document.getElementById('type-grid').addEventListener('input', (event) => {
  // Live-update the readout while dragging; only commit on release.
  const input = event.target.closest('input[type=range][data-type-key]');
  if (!input) return;
  const out = document.getElementById(`type-${input.dataset.typeKey}-out`);
  const control = TYPE_CONTROLS.find((c) => c.key === input.dataset.typeKey);
  if (out) out.textContent = `${input.value}${control?.unit ?? ''}`;
});

document.getElementById('type-grid').addEventListener('change', async (event) => {
  const input = event.target.closest('[data-type-key]');
  if (!input) return;
  const key = input.dataset.typeKey;
  const value = input.type === 'range' ? Number(input.value) : input.value;

  try {
    await api('/api/brand', { method: 'PATCH', body: JSON.stringify({ typography: { [key]: value } }) });
    await loadBrand();
    refreshPreview();
    toast('Typography updated across every page', 'ok');
  } catch (error) {
    toast(error.message, 'error');
    loadBrand();
  }
});

document.getElementById('brand-grid').addEventListener('change', async (event) => {
  const input = event.target.closest('[data-color]');
  if (!input) return;
  try {
    await api('/api/brand', {
      method: 'PATCH',
      body: JSON.stringify({ colors: { [input.dataset.color]: input.value } }),
    });
    await loadBrand();
    refreshPreview();
    toast('Brand updated across every page', 'ok');
  } catch (error) {
    toast(error.message, 'error');
    loadBrand();
  }
});

/* ------------------------------------------------------------------ */
/* History & audit                                                     */
/* ------------------------------------------------------------------ */

loaders.history = async () => {
  const { changeSets } = await api('/api/history');
  document.getElementById('history-list').innerHTML = changeSets.length ? changeSets.map((cs) => `
    <div class="note ${cs.status === 'reverted' ? '' : 'info'}">
      <strong>${esc(cs.title)}</strong>
      <span class="muted small"> · ${esc(cs.origin)} · ${esc(cs.status)}</span><br>
      <span class="muted small">${esc(cs.impact.join(', '))} · ${new Date(cs.createdAt).toLocaleTimeString()}</span>
      ${cs.status === 'applied' ? `<br><button type="button" class="btn btn-sm" data-revert="${esc(cs.id)}">Undo</button>` : ''}
    </div>`).join('') : '<p class="muted">No changes yet.</p>';
};

document.getElementById('history-list').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-revert]');
  if (!btn) return;
  try {
    await api(`/api/history/${encodeURIComponent(btn.dataset.revert)}/revert`, { method: 'POST' });
    await loadPages();
    await loadBrand();
    loaders.history();
    toast('Change reverted', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
});

loaders.audit = async () => {
  const { events } = await api('/api/audit');
  document.querySelector('#audit-table tbody').innerHTML = events.map((e) => `
    <tr>
      <td class="muted small">${new Date(e.at).toLocaleTimeString()}</td>
      <td>${esc(e.action)}</td>
      <td>${esc(e.outcome)}</td>
      <td class="muted small">${esc(e.permission ?? '—')}</td>
      <td class="muted small">${esc(e.targetType ?? '')} ${esc((e.targetId ?? '').slice(0, 14))}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No events yet.</td></tr>';
};

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(async function boot() {
  try {
    await loadSession();
    await loadPages();
    await loadBrand();
    const { stats } = await api('/api/facts');
    updateFactBadge(stats.pendingReview);
  } catch (error) {
    toast(`Could not load: ${error.message}`, 'error');
  }
})();
