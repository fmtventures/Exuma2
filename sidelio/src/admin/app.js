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
/* Brand kit                                                           */
/* ------------------------------------------------------------------ */

loaders.brand = loadBrand;

async function loadBrand() {
  const { brandKit, contrastIssues } = await api('/api/brand');
  state.brandKit = brandKit;

  document.getElementById('brand-grid').innerHTML = Object.entries(brandKit.colors).map(([name, value]) => `
    <div class="swatch">
      <input type="color" value="${esc(value)}" data-color="${esc(name)}" aria-label="${esc(name)}">
      <div>
        <label for="">${esc(name)}</label>
        <code>${esc(value)}</code>
      </div>
    </div>`).join('');

  document.getElementById('contrast-issues').innerHTML = contrastIssues.length
    ? `<h3>Contrast</h3>${contrastIssues.map((i) => `
        <div class="note ${i.kind === 'text' && i.level === 'fail' ? 'blocking' : 'warning'}">
          <strong>${esc(i.token)} — ${i.ratio}:1</strong><br>
          <span class="muted small">${i.kind === 'text' ? 'WCAG AA needs 4.5:1 for text.' : 'WCAG needs 3:1 so the component is distinguishable.'}</span>
        </div>`).join('')}`
    : '<h3>Contrast</h3><p class="muted small">All checked pairings pass WCAG AA.</p>';
}

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
