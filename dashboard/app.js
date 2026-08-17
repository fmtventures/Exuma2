/* ==========================================================================
   FT Ventures Development Dashboard
   No dependencies. Data comes from registry.json (or an inlined copy of it).
   Edits made in the browser are held in localStorage and copied back out as a
   patch — there is no backend, so nothing here silently mutates the registry.
   ========================================================================== */

(() => {
  'use strict';

  const LS_EDITS = 'ftv-dash-edits-v1';
  const LS_THEME = 'ftv-dash-theme-v1';

  const STATUS_ORDER = ['live', 'beta', 'building', 'paused', 'idea', 'unknown'];
  const STATUS_LABEL = {
    live: 'Live', beta: 'Beta', building: 'Building',
    paused: 'Paused', idea: 'Idea', unknown: 'Unknown',
  };
  const HEALTH_LABEL = {
    good: 'Healthy', warning: 'Needs attention', serious: 'At risk',
    critical: 'Broken', unknown: 'Unknown',
  };
  const CONN_LABEL = {
    'paid-addon': 'Paid add-on', 'bundled-free': 'Bundled free',
    api: 'API link', planned: 'Planned', idea: 'Idea',
  };
  const CONN_SHORT = { 'paid-addon': 'PAID', 'bundled-free': 'FREE', api: 'API', planned: 'PLAN', idea: 'IDEA' };

  const STALE_DAYS = 45;

  /* ---------------------------------------------------------------- icons */
  const ICON = {
    gauge: 'M12 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 0 3.5-3.5M12 3a9 9 0 0 1 9 9M3 12a9 9 0 0 1 9-9M3.5 16.5A9 9 0 0 1 3 12m17.5 4.5A9 9 0 0 0 21 12',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    link: 'M9.5 14.5 14.5 9.5M10.5 6.5l1.6-1.6a4 4 0 0 1 5.7 5.7l-1.6 1.6M13.5 17.5l-1.6 1.6a4 4 0 0 1-5.7-5.7l1.6-1.6',
    flag: 'M5 21V4m0 0 5.5 2L16 4l3 1.5V14l-3-1.5-5.5 2L5 12.5',
    users: 'M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM21 20v-1.5a4 4 0 0 0-3-3.87M15.5 3.75a3.5 3.5 0 0 1 0 6.5',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2',
    search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm4.6-1.9L20 20',
    check: 'M4 12.5 9 17.5 20 6.5',
    alert: 'M12 8.5v5m0 3h.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-9.5V16m0-8h.01',
    copy: 'M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8A1.5 1.5 0 0 1 13.5 20h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9Z',
    x: 'M6 6l12 12M18 6 6 18',
    ext: 'M14 4h6v6M20 4l-8.5 8.5M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.5 1.5m11.2 11.2 1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5',
    moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
    box: 'M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Zm0 0v18M3 7.5 12 12l9-4.5',
    pause: 'M9.5 5v14M14.5 5v14',
  };

  function icon(name, cls) {
    return `<svg class="ico ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;
  }

  /* ---------------------------------------------------------------- utils */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtInt = (n) => (n == null ? null : n.toLocaleString('en-CA'));

  function fmtTokens(n) {
    if (n == null) return null;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
  }

  function daysSince(iso) {
    if (!iso) return null;
    const then = new Date(iso + 'T00:00:00');
    if (isNaN(then)) return null;
    return Math.max(0, Math.round((Date.now() - then) / 86400000));
  }

  function fmtAge(iso) {
    const d = daysSince(iso);
    if (d == null) return 'never logged';
    if (d === 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 30) return d + 'd ago';
    const m = Math.round(d / 30.4);
    return m + (m === 1 ? ' month ago' : ' months ago');
  }

  /* ------------------------------------------------------------- app state */
  let DATA = null;
  let edits = {};
  let route = 'overview';
  let query = '';
  let statusFilter = 'all';
  let openToolId = null;
  let chartMode = {}; // cardId -> 'chart' | 'table'

  function loadEdits() {
    try { edits = JSON.parse(localStorage.getItem(LS_EDITS)) || {}; } catch { edits = {}; }
  }
  function saveEdits() {
    try { localStorage.setItem(LS_EDITS, JSON.stringify(edits)); } catch { /* storage may be blocked */ }
  }
  function editKey(id, path) { return id + '::' + path; }

  function setEdit(id, path, value) {
    const k = editKey(id, path);
    const original = rawValue(id, path);
    const same = String(original == null ? '' : original) === String(value == null ? '' : value);
    if (same) delete edits[k]; else edits[k] = value;
    saveEdits();
    renderEditsBar();
  }

  function rawValue(id, path) {
    const t = DATA.tools.find((x) => x.id === id);
    if (!t) return null;
    return path.split('.').reduce((o, k) => (o == null ? null : o[k]), t);
  }

  function val(id, path) {
    const k = editKey(id, path);
    return Object.prototype.hasOwnProperty.call(edits, k) ? edits[k] : rawValue(id, path);
  }
  function isEdited(id, path) { return Object.prototype.hasOwnProperty.call(edits, editKey(id, path)); }

  /** A tool with browser edits applied on top. */
  function tool(id) {
    const t = DATA.tools.find((x) => x.id === id);
    if (!t) return null;
    return {
      ...t,
      status: val(id, 'status') || 'unknown',
      health: val(id, 'health') || 'unknown',
      percentComplete: numOrNull(val(id, 'percentComplete')),
      repo: val(id, 'repo') || null,
      liveUrl: val(id, 'liveUrl') || null,
      lastTouched: val(id, 'lastTouched') || null,
      notes: val(id, 'notes') || '',
      effort: {
        hours: numOrNull(val(id, 'effort.hours')),
        tokens: numOrNull(val(id, 'effort.tokens')),
        sessions: numOrNull(val(id, 'effort.sessions')),
      },
      priority: {
        ...t.priority,
        rank: numOrNull(val(id, 'priority.rank')),
        impact: numOrNull(val(id, 'priority.impact')),
        effort: numOrNull(val(id, 'priority.effort')),
      },
    };
  }

  function numOrNull(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }

  const allTools = () => DATA.tools.map((t) => tool(t.id));
  const platformName = (id) => (DATA.platforms.find((p) => p.id === id) || {}).name || '—';
  const moduleById = (id) => DATA.modules.find((m) => m.id === id);
  const toolName = (id) => { const t = DATA.tools.find((x) => x.id === id); return t ? t.name : id; };

  /* --------------------------------------------------------------- filters */
  function visibleTools() {
    let list = allTools();
    if (statusFilter !== 'all') list = list.filter((t) => t.status === statusFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((t) =>
        [t.name, t.tagline, t.notes, t.repo, platformName(t.platformId), t.status,
          ...(t.provides || []).map((m) => (moduleById(m) || {}).name),
          ...(t.consumes || []).map((m) => (moduleById(m) || {}).name)]
          .filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    return list.sort((a, b) => {
      const ra = a.priority.rank == null ? 999 : a.priority.rank;
      const rb = b.priority.rank == null ? 999 : b.priority.rank;
      return ra - rb;
    });
  }

  /* ---------------------------------------------------------- small chunks */
  function statusPill(status) {
    const s = status || 'unknown';
    return `<span class="pill ${esc(s)}"><span class="dot"></span>${esc(STATUS_LABEL[s] || s)}</span>`;
  }

  function healthChip(health) {
    const h = health || 'unknown';
    const ic = h === 'good' ? 'check' : h === 'unknown' ? 'info' : 'alert';
    return `<span class="health ${esc(h)}">${icon(ic)}${esc(HEALTH_LABEL[h] || h)}</span>`;
  }

  function confBadge(c) {
    const label = { verified: 'verified', assumed: 'assumed', unknown: 'unknown' }[c] || c || 'assumed';
    return `<span class="conf ${esc(c || 'assumed')}" title="${esc((DATA.meta.confidenceLegend || {})[c] || '')}">${esc(label)}</span>`;
  }

  function meter(pct) {
    /* No empty track when the figure is unknown — a 0%-looking bar would be a lie. */
    if (pct == null) {
      return `<span class="faint" style="font-size:11.5px">Progress not estimated</span>`;
    }
    const p = Math.max(0, Math.min(100, pct));
    return `<div class="meter"><div class="meter-track"><div class="meter-fill" style="width:${p}%"></div></div>
      <span class="meter-val">${p}%</span></div>`;
  }

  /* ================================================================ CHARTS */

  /**
   * Horizontal bar chart. Single series, every bar directly labelled — which is
   * also the relief the light-mode palette requires.
   */
  function barChart(rows, opts) {
    const o = Object.assign({ unit: '', barH: 20, gap: 9, labelW: 168, valueW: 62 }, opts || {});
    if (!rows.length) return '';
    const max = Math.max(...rows.map((r) => r.value), 1);
    const h = rows.length * (o.barH + o.gap) - o.gap;
    const plotW = 640 - o.labelW - o.valueW;
    const W = 640;

    const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
    const grid = ticks.map((t) => {
      const x = o.labelW + (t / max) * plotW;
      return `<line class="grid-line" x1="${x}" y1="0" x2="${x}" y2="${h}"/>
              <text class="tick" x="${x}" y="${h + 13}" text-anchor="middle">${esc(o.fmt ? o.fmt(t) : t)}</text>`;
    }).join('');

    const bars = rows.map((r, i) => {
      const y = i * (o.barH + o.gap);
      const w = Math.max(2, (r.value / max) * plotW);
      const color = r.color || 'var(--s1)';
      return `<g>
        <text class="cat-label" x="${o.labelW - 10}" y="${y + o.barH / 2 + 4}" text-anchor="end">${esc(r.label)}</text>
        <rect class="bar" x="${o.labelW}" y="${y}" width="${w}" height="${o.barH}" fill="${color}"><title>${esc(r.label)}: ${esc(r.display)}</title></rect>
        <text class="bar-label" x="${o.labelW + w + 8}" y="${y + o.barH / 2 + 4}">${esc(r.display)}</text>
      </g>`;
    }).join('');

    return `<svg class="chart" viewBox="0 0 ${W} ${h + 22}" role="img"
      aria-label="${esc(o.aria || 'Bar chart')}" preserveAspectRatio="xMinYMin meet">
      ${grid}${bars}
      <line class="axis-line" x1="${o.labelW}" y1="0" x2="${o.labelW}" y2="${h}"/>
    </svg>`;
  }

  /** Impact x effort scatter, for choosing what to do next. */
  function quadrant(items) {
    const W = 560, H = 380, pad = { t: 26, r: 22, b: 40, l: 46 };
    const px = (v) => pad.l + ((v - 0.5) / 5) * (W - pad.l - pad.r);
    const py = (v) => H - pad.b - ((v - 0.5) / 5) * (H - pad.t - pad.b);

    const grid = [1, 2, 3, 4, 5].map((v) =>
      `<line class="grid-line" x1="${px(v)}" y1="${pad.t}" x2="${px(v)}" y2="${H - pad.b}"/>
       <line class="grid-line" x1="${pad.l}" y1="${py(v)}" x2="${W - pad.r}" y2="${py(v)}"/>
       <text class="tick" x="${px(v)}" y="${H - pad.b + 15}" text-anchor="middle">${v}</text>
       <text class="tick" x="${pad.l - 8}" y="${py(v) + 4}" text-anchor="end">${v}</text>`).join('');

    const midX = px(3), midY = py(3);
    const quadLines = `<line class="axis-line" x1="${midX}" y1="${pad.t}" x2="${midX}" y2="${H - pad.b}" stroke-dasharray="3 3"/>
      <line class="axis-line" x1="${pad.l}" y1="${midY}" x2="${W - pad.r}" y2="${midY}" stroke-dasharray="3 3"/>`;

    const quadText = `
      <text class="quad-label" x="${pad.l + 6}" y="${pad.t + 12}">Quick wins</text>
      <text class="quad-label" x="${W - pad.r - 6}" y="${pad.t + 12}" text-anchor="end">Big bets</text>
      <text class="quad-label" x="${pad.l + 6}" y="${H - pad.b - 6}">Fill-ins</text>
      <text class="quad-label" x="${W - pad.r - 6}" y="${H - pad.b - 6}" text-anchor="end">Money pits</text>`;

    /* Impact and effort are 1–5 integers, so ties are the norm rather than the
       exception. Stack tied tools vertically inside their cell so every dot and
       every label stays readable instead of overprinting. */
    const cells = new Map();
    items.forEach((t) => {
      const k = `${t.priority.effort}:${t.priority.impact}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(t);
    });

    const cellH = (H - pad.t - pad.b) / 5;
    const dots = Array.from(cells.values()).map((members) => {
      const n = members.length;
      const step = Math.min(15, (cellH - 6) / Math.max(1, n));
      return members.map((t, i) => {
        const cx = px(t.priority.effort);
        const cy = py(t.priority.impact) + (i - (n - 1) / 2) * step;
        const color = `var(--life-${t.status || 'unknown'})`;
        const short = t.name.length > 17 ? t.name.slice(0, 16) + '…' : t.name;
        /* Point the label away from any tool further right on the same impact
           row, so a label never runs across the next column's dots. */
        const blockedRight = items.some((o) =>
          o.priority.impact === t.priority.impact && o.priority.effort > t.priority.effort);
        const toRight = !blockedRight && cx <= W * 0.62;
        return `<g>
          <circle class="dot-mark" cx="${cx}" cy="${cy}" r="5.5" fill="${color}"
            data-tool="${esc(t.id)}"><title>${esc(t.name)} — impact ${t.priority.impact}, effort ${t.priority.effort}</title></circle>
          <text class="dot-label" x="${cx + (toRight ? 10 : -10)}" y="${cy + 3.5}"
            text-anchor="${toRight ? 'start' : 'end'}">${esc(short)}</text>
        </g>`;
      }).join('');
    }).join('');

    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Impact against effort for each tool" preserveAspectRatio="xMinYMin meet">
      ${grid}${quadLines}${quadText}${dots}
      <text class="tick" x="${(pad.l + W - pad.r) / 2}" y="${H - 6}" text-anchor="middle">Effort  →</text>
      <text class="tick" x="12" y="${(pad.t + H - pad.b) / 2}" text-anchor="middle"
        transform="rotate(-90 12 ${(pad.t + H - pad.b) / 2})">Impact  →</text>
    </svg>`;
  }

  /** Chart cards carry a table toggle — the accessible equivalent of the plot. */
  function chartCard(id, title, note, chartHtml, tableHtml, extraHead) {
    const mode = chartMode[id] || 'chart';
    return `<section class="card">
      <div class="card-head">
        <h2>${esc(title)}</h2>
        ${extraHead || ''}
        <div class="spacer"></div>
        <button class="btn btn-sm btn-ghost" data-chartmode="${esc(id)}">${mode === 'chart' ? 'Table' : 'Chart'}</button>
      </div>
      <div class="card-body">
        ${note ? `<p class="section-note" style="margin-bottom:14px">${note}</p>` : ''}
        ${mode === 'chart' ? chartHtml : `<div class="table-wrap">${tableHtml}</div>`}
      </div>
    </section>`;
  }

  /* ============================================================== OVERVIEW */
  function renderOverview() {
    const tools = allTools();
    const byStatus = (s) => tools.filter((t) => t.status === s).length;

    const trackedHours = tools.filter((t) => t.effort.hours != null);
    const trackedTokens = tools.filter((t) => t.effort.tokens != null);
    const sumHours = trackedHours.reduce((a, t) => a + t.effort.hours, 0);
    const sumTokens = trackedTokens.reduce((a, t) => a + t.effort.tokens, 0);

    const unknowns = tools.filter((t) => t.confidence === 'unknown').length;
    const noRepo = tools.filter((t) => !t.repo).length;
    const stale = tools.filter((t) => {
      const d = daysSince(t.lastTouched);
      return d != null && d > STALE_DAYS && t.status !== 'paused';
    });

    const tiles = `
      <div class="tiles">
        <div class="tile">
          <span class="eyebrow">Tools tracked</span>
          <span class="tile-val num">${tools.length}</span>
          <span class="tile-sub">${byStatus('live')} live · ${byStatus('building')} building · ${byStatus('paused')} paused</span>
        </div>
        <div class="tile">
          <span class="eyebrow">Needs your input</span>
          <span class="tile-val num">${unknowns}</span>
          <span class="tile-sub">tools I could not identify</span>
        </div>
        <div class="tile">
          <span class="eyebrow">Missing a repo link</span>
          <span class="tile-val num">${noRepo}</span>
          <span class="tile-sub">can't be developed from here yet</span>
        </div>
        <div class="tile">
          <span class="eyebrow">Hours logged</span>
          <span class="tile-val ${trackedHours.length ? '' : 'untracked'}">${trackedHours.length ? fmtInt(sumHours) : 'Not tracked'}</span>
          <span class="tile-sub">${trackedHours.length ? `across ${trackedHours.length} tools` : 'starts when we log the first session'}</span>
        </div>
        <div class="tile">
          <span class="eyebrow">Tokens logged</span>
          <span class="tile-val ${trackedTokens.length ? '' : 'untracked'}">${trackedTokens.length ? fmtTokens(sumTokens) : 'Not tracked'}</span>
          <span class="tile-sub">${trackedTokens.length ? `across ${trackedTokens.length} tools` : 'needs a number per session from you'}</span>
        </div>
      </div>`;

    /* attention list — real, derived signals only */
    const attn = [];
    tools.forEach((t) => {
      (t.blockers || []).forEach((b) =>
        attn.push({ sev: 'critical', ico: 'alert', who: t.name, what: b.text, id: t.id }));
    });
    stale.forEach((t) =>
      attn.push({ sev: 'serious', ico: 'clock', who: t.name, what:
        `No activity in ${fmtAge(t.lastTouched)} — keep, finish, or archive?`, id: t.id }));
    /* A tool already flagged as blocked does not need a second, weaker row. */
    tools.filter((t) => !t.repo && t.status !== 'idea' && !(t.blockers || []).length).forEach((t) =>
      attn.push({ sev: 'warning', ico: 'info', who: t.name, what:
        'No repo linked, so we cannot open it from here.', id: t.id }));

    const attnHtml = attn.length ? `<ul class="attn">${attn.map((a) => `
      <li>
        <span class="health ${esc(a.sev)}" style="margin-top:1px">${icon(a.ico)}</span>
        <span class="body">
          <span class="who">${esc(a.who)}</span>
          <span class="what">${esc(a.what)}</span>
        </span>
        <button class="btn btn-sm jump" data-open="${esc(a.id)}">Open</button>
      </li>`).join('')}</ul>`
      : `<p class="section-note">Nothing flagged.</p>`;

    /* priorities */
    const ranked = tools.filter((t) => t.priority.rank != null)
      .sort((a, b) => a.priority.rank - b.priority.rank).slice(0, 6);
    const prioHtml = `<ul class="prio">${ranked.map((t, i) => `
      <li>
        <span class="rank">${i + 1}</span>
        <span class="body">
          <span class="who">${esc(t.name)}</span>
          <span class="why">${esc(t.priority.rationale || '')}</span>
        </span>
        <span class="ie">
          <div><span class="k">Impact</span><br><span class="v">${t.priority.impact ?? '—'}</span></div>
          <div><span class="k">Effort</span><br><span class="v">${t.priority.effort ?? '—'}</span></div>
        </span>
        <button class="btn btn-sm jump" data-open="${esc(t.id)}">Open</button>
      </li>`).join('')}</ul>`;

    /* staleness chart — real data from lastTouched */
    const ageRows = tools.filter((t) => t.lastTouched)
      .map((t) => ({ t, d: daysSince(t.lastTouched) }))
      .sort((a, b) => b.d - a.d)
      .map(({ t, d }) => ({
        label: t.name.length > 24 ? t.name.slice(0, 23) + '…' : t.name,
        value: d,
        display: d === 0 ? 'today' : d + 'd',
        color: d > STALE_DAYS ? 'var(--s2)' : 'var(--s1)',
      }));

    const ageTable = `<table class="data">
      <thead><tr><th>Tool</th><th>Status</th><th class="n">Last touched</th><th class="n">Days</th></tr></thead>
      <tbody>${tools.filter((t) => t.lastTouched)
        .sort((a, b) => daysSince(b.lastTouched) - daysSince(a.lastTouched))
        .map((t) => `<tr><td>${esc(t.name)}</td><td>${statusPill(t.status)}</td>
          <td class="n">${esc(t.lastTouched)}</td><td class="n">${daysSince(t.lastTouched)}</td></tr>`).join('')}
      </tbody></table>`;

    const noDateCount = tools.filter((t) => !t.lastTouched).length;

    return `
      ${tiles}

      <div class="split">
        <section class="card">
          <div class="card-head">${icon('alert')}<h2>Needs a decision</h2>
            <div class="spacer"></div><span class="topbar-meta">${attn.length} item${attn.length === 1 ? '' : 's'}</span></div>
          <div class="card-body">${attnHtml}</div>
        </section>

        <section class="card">
          <div class="card-head">${icon('flag')}<h2>Current priority order</h2></div>
          <div class="card-body">
            ${prioHtml}
            <p class="section-note" style="margin-top:12px">This order is my proposal, not a decision.
              Change any rank in a tool's panel and the list re-sorts.</p>
          </div>
        </section>
      </div>

      ${chartCard('age', 'Time since last activity',
        `Real data, from the last push to each repo or the last session I can account for.${noDateCount ? ` ${noDateCount} tool${noDateCount === 1 ? ' has' : 's have'} no date on record yet.` : ''} Orange means nothing has moved in over ${STALE_DAYS} days.`,
        barChart(ageRows, { aria: 'Days since last activity per tool', fmt: (v) => v + 'd' }),
        ageTable)}
    `;
  }

  /* ================================================================= TOOLS */
  function renderTools() {
    const tools = visibleTools();
    const counts = {};
    STATUS_ORDER.forEach((s) => { counts[s] = allTools().filter((t) => t.status === s).length; });

    const chips = ['all'].concat(STATUS_ORDER.filter((s) => counts[s] > 0)).map((s) => `
      <button class="chip" data-status="${esc(s)}" aria-pressed="${statusFilter === s}">
        ${s === 'all' ? 'All' : esc(STATUS_LABEL[s])}
        <span class="n">${s === 'all' ? allTools().length : counts[s]}</span>
      </button>`).join('');

    const cards = tools.map((t) => {
      const d = daysSince(t.lastTouched);
      const isStale = d != null && d > STALE_DAYS && t.status !== 'paused';
      const provides = (t.provides || []).map((m) => (moduleById(m) || {}).name).filter(Boolean);
      return `
      <button class="tool-card ${esc(t.status)}" data-open="${esc(t.id)}">
        <span class="stripe"></span>
        <span class="tool-card-inner">
          <span class="tool-card-top">
            <h3>${esc(t.name)}</h3>
            <span style="margin-left:auto">${confBadge(t.confidence)}</span>
          </span>
          <span class="tagline">${esc(t.tagline)}</span>
          <span class="tool-card-rowline">
            ${statusPill(t.status)}
            ${healthChip(t.health)}
          </span>
          ${meter(t.percentComplete)}
          ${provides.length ? `<span class="tool-card-rowline">${provides.map((p) => `<span class="tag">${esc(p)}</span>`).join('')}</span>` : ''}
          <span class="tool-card-foot">
            <span>${esc(platformName(t.platformId))}</span>
            <span class="sep"></span>
            <span class="${isStale ? 'stale-flag' : ''}">${esc(fmtAge(t.lastTouched))}</span>
          </span>
        </span>
      </button>`;
    }).join('');

    return `
      <div class="section-title">
        <h2>All tools</h2>
        <span class="section-note">${tools.length} shown${query ? ` matching “${esc(query)}”` : ''}. Click any card to open, edit and copy a working brief.</span>
      </div>
      <div class="filters">${chips}</div>
      ${tools.length ? `<div class="tool-grid">${cards}</div>`
        : `<div class="empty-state"><h3>Nothing matches</h3><p>Clear the search or pick a different status.</p></div>`}
    `;
  }

  /* ========================================================== CONNECTIONS */
  function renderModules() {
    const mods = DATA.modules;
    const conns = DATA.connections;

    /* columns: tools that host or own a module */
    const colIds = Array.from(new Set(
      conns.map((c) => c.toToolId).concat(mods.map((m) => m.ownerToolId).filter(Boolean))
    )).filter((id) => DATA.tools.some((t) => t.id === id));

    const header = colIds.map((id) => `<th>${esc(toolName(id))}</th>`).join('');

    const body = mods.map((m) => {
      const cells = colIds.map((cid) => {
        if (m.ownerToolId === cid) return `<td><span class="cell self" title="${esc(toolName(cid))} owns this module">OWNER</span></td>`;
        const c = conns.find((x) => x.moduleId === m.id && x.toToolId === cid);
        if (!c) return `<td><span class="cell empty"></span></td>`;
        const cls = c.status === 'live' ? 'live' : c.status === 'planned' ? 'planned' : 'idea';
        return `<td><span class="cell ${cls}" title="${esc(CONN_LABEL[c.type] || c.type)} · ${esc(c.status)} — ${esc(c.notes || '')}">${esc(CONN_SHORT[c.type] || '·')}</span></td>`;
      }).join('');
      return `<tr><th>${esc(m.name)}<span class="owner">${esc(m.ownerToolId ? toolName(m.ownerToolId) : 'no owner yet')}</span></th>${cells}</tr>`;
    }).join('');

    const connTable = `<table class="data">
      <thead><tr><th>Module</th><th>Owned by</th><th>Attaches to</th><th>Commercial model</th><th>State</th><th>Note</th></tr></thead>
      <tbody>${conns.map((c) => {
        const m = moduleById(c.moduleId) || {};
        return `<tr>
          <td><strong>${esc(m.name || c.moduleId)}</strong></td>
          <td>${esc(m.ownerToolId ? toolName(m.ownerToolId) : '—')}</td>
          <td>${esc(toolName(c.toToolId))}</td>
          <td><span class="tag">${esc(CONN_LABEL[c.type] || c.type)}</span></td>
          <td>${esc(c.status)}</td>
          <td class="dim">${esc(c.notes || '')}</td>
        </tr>`;
      }).join('')}</tbody></table>`;

    return `
      <div class="section-title">
        <h2>Modules and connections</h2>
        <span class="section-note">Which capability plugs into which product, and on what commercial terms.
          Rows are modules, columns are the products that host them.</span>
      </div>

      <section class="card">
        <div class="card-head">${icon('link')}<h2>Attachment matrix</h2>
          <div class="spacer"></div>
          <span class="topbar-meta">${conns.length} connections</span>
        </div>
        <div class="card-body">
          <div class="matrix-wrap">
            <table class="matrix"><thead><tr><th></th>${header}</tr></thead><tbody>${body}</tbody></table>
          </div>
          <div class="legend-row" style="margin-top:16px">
            <span class="legend-key"><span class="legend-swatch" style="background:var(--life-live);border-color:var(--life-live)"></span>Live now</span>
            <span class="legend-key"><span class="legend-swatch" style="background:var(--accent-soft);border-color:var(--accent-line)"></span>Planned</span>
            <span class="legend-key"><span class="legend-swatch" style="background:transparent;border-style:dashed"></span>Idea only</span>
            <span class="legend-key"><span class="legend-swatch" style="background:var(--surface-3)"></span>Owns the module</span>
            <span class="legend-key faint">FREE = bundled free · PAID = paid add-on · API = service link</span>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">${icon('box')}<h2>Every connection in words</h2></div>
        <div class="card-body"><div class="table-wrap">${connTable}</div></div>
      </section>

      <div class="empty-state">
        <h3>The decision this view exists for</h3>
        <p>You described two commercial models: a module people <strong>buy as an add-on</strong> to a tool they already
          own, and a module you <strong>give away free</strong> inside a bigger platform. The Site Builder row shows both
          at once — paid into BF, free into the platform. Once you confirm which products really host it,
          this becomes the map we build the entitlement logic from.</p>
      </div>
    `;
  }

  /* ============================================================ PRIORITIES */
  function renderPriorities() {
    const tools = allTools().filter((t) => t.priority.impact != null && t.priority.effort != null);
    const ranked = allTools().filter((t) => t.priority.rank != null)
      .sort((a, b) => a.priority.rank - b.priority.rank);

    const table = `<table class="data">
      <thead><tr><th class="n">#</th><th>Tool</th><th>Status</th><th class="n">Impact</th><th class="n">Effort</th><th>Why this rank</th></tr></thead>
      <tbody>${ranked.map((t, i) => `<tr>
        <td class="n">${i + 1}</td>
        <td><strong>${esc(t.name)}</strong></td>
        <td>${statusPill(t.status)}</td>
        <td class="n">${t.priority.impact ?? '—'}</td>
        <td class="n">${t.priority.effort ?? '—'}</td>
        <td class="dim">${esc(t.priority.rationale || '')}</td>
      </tr>`).join('')}</tbody></table>`;

    return `
      <div class="section-title">
        <h2>Priorities</h2>
        <span class="section-note">Impact and effort are both 1–5, scored by me as a starting position.
          Overwrite them in each tool's panel — this is the view we argue in front of.</span>
      </div>

      <div class="split">
        ${chartCard('quad', 'Impact against effort',
          'Top-left is where to spend time first. Dot colour is the tool\'s stage; every dot is labelled.',
          quadrant(tools), table)}

        <section class="card">
          <div class="card-head">${icon('flag')}<h2>Ranked order</h2></div>
          <div class="card-body">
            <ul class="prio">${ranked.map((t, i) => `
              <li>
                <span class="rank">${i + 1}</span>
                <span class="body">
                  <span class="who">${esc(t.name)}</span>
                  <span class="why">${esc(t.priority.rationale || '')}</span>
                </span>
                <button class="btn btn-sm jump" data-open="${esc(t.id)}">Open</button>
              </li>`).join('')}
            </ul>
          </div>
        </section>
      </div>
    `;
  }

  /* =============================================================== CLIENTS */
  function renderClients() {
    const rows = DATA.clients.map((c) => `<tr>
      <td><strong>${esc(c.name)}</strong><br><span class="tag">${esc(c.type)}</span></td>
      <td>${(c.toolIds || []).map((id) => `<span class="tag">${esc(toolName(id))}</span>`).join(' ') || '<span class="faint">—</span>'}</td>
      <td>${esc(c.since || '—')}</td>
      <td>${confBadge(c.confidence)}</td>
      <td class="dim">${esc(c.notes || '')}</td>
    </tr>`).join('');

    /* who uses what, inverted */
    const usage = allTools().map((t) => ({
      t, users: DATA.clients.filter((c) => (c.toolIds || []).includes(t.id)),
    })).filter((u) => u.users.length);

    return `
      <div class="section-title">
        <h2>Who uses what</h2>
        <span class="section-note">Thin on purpose — I only know what you have told me. The paying cohort
          is the row worth filling in first, because it decides which tool earns the next module.</span>
      </div>

      <section class="card">
        <div class="card-head">${icon('users')}<h2>Client and user groups</h2></div>
        <div class="card-body"><div class="table-wrap">
          <table class="data"><thead><tr><th>Group</th><th>Tools they use</th><th>Since</th><th>Confidence</th><th>Note</th></tr></thead>
          <tbody>${rows}</tbody></table>
        </div></div>
      </section>

      <section class="card">
        <div class="card-head">${icon('box')}<h2>Tools by audience</h2></div>
        <div class="card-body"><div class="table-wrap">
          <table class="data"><thead><tr><th>Tool</th><th>Status</th><th>Used by</th></tr></thead>
          <tbody>${usage.map((u) => `<tr>
            <td><strong>${esc(u.t.name)}</strong></td>
            <td>${statusPill(u.t.status)}</td>
            <td>${u.users.map((c) => `<span class="tag">${esc(c.name)}</span>`).join(' ')}</td>
          </tr>`).join('')}</tbody></table>
        </div></div>
      </section>

      <div class="empty-state">
        <h3>What is missing</h3>
        <p>No seat counts, no revenue, no signup dates. If you tell me roughly how many people are on BF,
          how many PEIAGENTS agents actively use the skills, and what each product charges, this view starts
          answering “which tool deserves the next week of work” with numbers instead of instinct.</p>
      </div>
    `;
  }

  /* =================================================================== LOG */
  function renderLog() {
    const log = DATA.log || [];
    const tools = allTools();

    const effortRows = tools.filter((t) => t.effort.hours != null)
      .sort((a, b) => b.effort.hours - a.effort.hours)
      .map((t) => ({ label: t.name, value: t.effort.hours, display: t.effort.hours + 'h' }));

    const tokenRows = tools.filter((t) => t.effort.tokens != null)
      .sort((a, b) => b.effort.tokens - a.effort.tokens)
      .map((t) => ({ label: t.name, value: t.effort.tokens, display: fmtTokens(t.effort.tokens), color: 'var(--s3)' }));

    const effortTable = `<table class="data">
      <thead><tr><th>Tool</th><th class="n">Hours</th><th class="n">Tokens</th><th class="n">Sessions</th></tr></thead>
      <tbody>${tools.map((t) => `<tr>
        <td>${esc(t.name)}</td>
        <td class="n">${t.effort.hours ?? '<span class="faint">—</span>'}</td>
        <td class="n">${t.effort.tokens != null ? fmtTokens(t.effort.tokens) : '<span class="faint">—</span>'}</td>
        <td class="n">${t.effort.sessions ?? '<span class="faint">—</span>'}</td>
      </tr>`).join('')}</tbody></table>`;

    const logTable = log.length ? `<table class="data">
      <thead><tr><th>Date</th><th>Tool</th><th>What happened</th><th class="n">Hours</th><th class="n">Tokens</th></tr></thead>
      <tbody>${log.slice().reverse().map((e) => `<tr>
        <td class="n">${esc(e.date)}</td>
        <td>${esc(toolName(e.toolId))}</td>
        <td>${esc(e.summary)}</td>
        <td class="n">${e.hours ?? '—'}</td>
        <td class="n">${e.tokens != null ? fmtTokens(e.tokens) : '—'}</td>
      </tr>`).join('')}</tbody></table>` : '';

    const haveEffort = effortRows.length || tokenRows.length;

    return `
      <div class="section-title">
        <h2>Time and tokens</h2>
        <span class="section-note">Every figure here is blank, and that is deliberate — I have no record of
          hours or token spend from the earlier chats, so inventing numbers would make this view worse than useless.</span>
      </div>

      ${haveEffort ? `
        ${effortRows.length ? chartCard('hours', 'Hours per tool', '', barChart(effortRows, { aria: 'Hours per tool', fmt: (v) => v + 'h' }), effortTable) : ''}
        ${tokenRows.length ? chartCard('tokens', 'Tokens per tool', '', barChart(tokenRows, { aria: 'Tokens per tool', fmt: fmtTokens }), effortTable) : ''}
      ` : `
        <div class="empty-state">
          <h3>Nothing logged yet</h3>
          <p>Two ways to start. Either open a tool and type the hours and tokens you remember into its panel —
            rough is fine, and the numbers stay marked as yours — or from here on I add a log line at the end of
            every session we do, which is the version that stays accurate without you having to remember anything.</p>
          <p><strong>On tokens specifically:</strong> I cannot read your account usage, so a token figure has to come
            from you or from me noting it per session. There is no API I can call to backfill the ten chats that already happened.</p>
        </div>
      `}

      <section class="card">
        <div class="card-head">${icon('clock')}<h2>Effort by tool</h2>
          <div class="spacer"></div><span class="topbar-meta">${tools.filter((t) => t.effort.hours != null).length} of ${tools.length} tracked</span></div>
        <div class="card-body"><div class="table-wrap">${effortTable}</div></div>
      </section>

      ${logTable ? `<section class="card">
        <div class="card-head">${icon('check')}<h2>Session log</h2></div>
        <div class="card-body"><div class="table-wrap">${logTable}</div></div>
      </section>` : ''}
    `;
  }

  /* ========================================================= DETAIL PANEL */
  function renderPanel() {
    const scrim = $('#scrim'), panel = $('#panel');
    if (!openToolId) { scrim.hidden = true; panel.hidden = true; return; }
    const t = tool(openToolId);
    if (!t) { openToolId = null; scrim.hidden = true; panel.hidden = true; return; }

    const provides = (t.provides || []).map((m) => moduleById(m)).filter(Boolean);
    const consumes = (t.consumes || []).map((m) => moduleById(m)).filter(Boolean);
    const related = DATA.connections.filter((c) =>
      c.toToolId === t.id || provides.some((p) => p.id === c.moduleId));

    const field = (label, path, type, opts) => {
      const v = val(t.id, path);
      const cls = isEdited(t.id, path) ? 'edited' : '';
      if (type === 'select') {
        return `<div class="field"><label for="f-${path}">${esc(label)}</label>
          <select id="f-${path}" class="${cls}" data-field="${esc(path)}">
            ${opts.map((o) => `<option value="${esc(o)}" ${String(v) === o ? 'selected' : ''}>${esc(STATUS_LABEL[o] || HEALTH_LABEL[o] || o)}</option>`).join('')}
          </select></div>`;
      }
      return `<div class="field"><label for="f-${path}">${esc(label)}</label>
        <input id="f-${path}" class="${cls}" data-field="${esc(path)}" type="${type || 'text'}"
          value="${esc(v == null ? '' : v)}" ${type === 'number' ? 'min="0"' : ''}
          placeholder="${type === 'number' ? 'not tracked' : ''}"></div>`;
    };

    $('#panel-content').innerHTML = `
      <div class="panel-head">
        <div class="panel-head-top">
          <div>
            <span class="eyebrow">${esc(platformName(t.platformId))}</span>
            <h2>${esc(t.name)}</h2>
          </div>
          <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
            ${confBadge(t.confidence)}
            <button class="btn btn-sm btn-ghost" id="panel-close" aria-label="Close">${icon('x')}</button>
          </div>
        </div>
        <p class="dim" style="font-size:12.5px">${esc(t.tagline)}</p>
        <div class="tool-card-rowline">${statusPill(t.status)}${healthChip(t.health)}
          <span class="tag">last activity ${esc(fmtAge(t.lastTouched))}</span></div>
      </div>

      <div class="panel-body">
        <div class="sub">
          <span class="eyebrow">State</span>
          <div class="field-grid">
            ${field('Status', 'status', 'select', STATUS_ORDER)}
            ${field('Health', 'health', 'select', ['good', 'warning', 'serious', 'critical', 'unknown'])}
            ${field('Percent complete', 'percentComplete', 'number')}
            ${field('Last touched', 'lastTouched', 'date')}
          </div>
        </div>

        <div class="sub">
          <span class="eyebrow">Where it lives</span>
          <div class="field-grid">
            ${field('Repo (owner/name)', 'repo', 'text')}
            ${field('Live URL', 'liveUrl', 'text')}
          </div>
          <div class="linklist">
            ${t.repo ? `<a class="btn btn-sm" href="https://github.com/${esc(t.repo)}" target="_blank" rel="noopener">${icon('ext')}${esc(t.repo)}</a>` : ''}
            ${t.liveUrl ? `<a class="btn btn-sm" href="${esc(t.liveUrl)}" target="_blank" rel="noopener">${icon('ext')}Open live</a>` : ''}
            ${t.adminUrl ? `<a class="btn btn-sm" href="${esc(t.adminUrl)}" target="_blank" rel="noopener">${icon('ext')}Admin</a>` : ''}
          </div>
        </div>

        <div class="sub">
          <span class="eyebrow">Effort — your numbers, not mine</span>
          <div class="field-grid">
            ${field('Hours', 'effort.hours', 'number')}
            ${field('Tokens', 'effort.tokens', 'number')}
            ${field('Sessions', 'effort.sessions', 'number')}
            <div class="field"><label>Source</label>
              <span class="hint">Blank means never measured. Anything you type is treated as your estimate.</span></div>
          </div>
        </div>

        <div class="sub">
          <span class="eyebrow">Priority</span>
          <div class="field-grid">
            ${field('Rank', 'priority.rank', 'number')}
            ${field('Impact 1–5', 'priority.impact', 'number')}
            ${field('Effort 1–5', 'priority.effort', 'number')}
          </div>
          ${t.priority.rationale ? `<div class="note-block">${esc(t.priority.rationale)}</div>` : ''}
        </div>

        ${(t.blockers || []).length ? `<div class="sub">
          <span class="eyebrow">Blocked on</span>
          ${t.blockers.map((b) => `<div class="blocker">${icon('alert')}<span>${esc(b.text)}
            ${b.since ? `<br><span class="faint mono" style="font-size:10.5px">since ${esc(b.since)}</span>` : ''}</span></div>`).join('')}
        </div>` : ''}

        ${(t.nextActions || []).length ? `<div class="sub">
          <span class="eyebrow">Next actions</span>
          <ul class="checklist">${t.nextActions.map((a, i) => `
            <li class="${a.done ? 'done' : ''}">
              <input type="checkbox" id="na-${i}" data-action="${i}" ${a.done ? 'checked' : ''}>
              <label for="na-${i}"><span>${esc(a.text)}</span></label>
            </li>`).join('')}</ul>
        </div>` : ''}

        ${(provides.length || consumes.length) ? `<div class="sub">
          <span class="eyebrow">Modules</span>
          ${provides.length ? `<p style="font-size:12.5px"><strong>Provides:</strong>
            ${provides.map((m) => `<span class="tag">${esc(m.name)}</span>`).join(' ')}</p>` : ''}
          ${consumes.length ? `<p style="font-size:12.5px"><strong>Consumes:</strong>
            ${consumes.map((m) => `<span class="tag">${esc(m.name)}</span>`).join(' ')}</p>` : ''}
        </div>` : ''}

        ${related.length ? `<div class="sub">
          <span class="eyebrow">Connections</span>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Module</th><th>Direction</th><th>Model</th><th>State</th></tr></thead>
            <tbody>${related.map((c) => {
              const m = moduleById(c.moduleId) || {};
              const dir = c.toToolId === t.id ? `into ${t.name}` : `${t.name} → ${toolName(c.toToolId)}`;
              return `<tr><td>${esc(m.name || c.moduleId)}</td><td class="dim">${esc(dir)}</td>
                <td><span class="tag">${esc(CONN_LABEL[c.type] || c.type)}</span></td><td>${esc(c.status)}</td></tr>`;
            }).join('')}</tbody></table></div>
        </div>` : ''}

        <div class="sub">
          <span class="eyebrow">Notes</span>
          <div class="field">
            <textarea data-field="notes" class="${isEdited(t.id, 'notes') ? 'edited' : ''}" rows="4">${esc(t.notes)}</textarea>
          </div>
        </div>
      </div>

      <div class="panel-foot">
        <button class="btn btn-primary btn-sm" id="copy-brief">${icon('copy')}Copy working brief</button>
        <span class="hint faint" style="font-size:11px">Paste into a new chat to pick this tool up with full context.</span>
      </div>
    `;

    scrim.hidden = false;
    panel.hidden = false;
    panel.focus();
  }

  /** A paste-ready brief so a fresh chat starts with the full picture. */
  function buildBrief(t) {
    const provides = (t.provides || []).map((m) => (moduleById(m) || {}).name).filter(Boolean);
    const consumes = (t.consumes || []).map((m) => (moduleById(m) || {}).name).filter(Boolean);
    const related = DATA.connections.filter((c) =>
      c.toToolId === t.id || (t.provides || []).includes(c.moduleId));

    const lines = [
      `# Working on: ${t.name}`,
      ``,
      `Platform: ${platformName(t.platformId)}`,
      `Status: ${STATUS_LABEL[t.status] || t.status} · Health: ${HEALTH_LABEL[t.health] || t.health}` +
        (t.percentComplete != null ? ` · ${t.percentComplete}% complete` : ''),
      `Repo: ${t.repo || 'NOT LINKED YET'}`,
      t.liveUrl ? `Live: ${t.liveUrl}` : null,
      `Data confidence: ${t.confidence}`,
      `Last activity: ${fmtAge(t.lastTouched)}${t.lastTouched ? ` (${t.lastTouched})` : ''}`,
      ``,
      `## What it is`,
      t.tagline,
      ``,
    ];

    if (provides.length) lines.push(`## Modules it provides`, ...provides.map((p) => `- ${p}`), ``);
    if (consumes.length) lines.push(`## Modules it consumes`, ...consumes.map((p) => `- ${p}`), ``);

    if (related.length) {
      lines.push(`## Connections`);
      related.forEach((c) => {
        const m = moduleById(c.moduleId) || {};
        const dir = c.toToolId === t.id ? `${m.name} → ${t.name}` : `${m.name} → ${toolName(c.toToolId)}`;
        lines.push(`- ${dir} — ${CONN_LABEL[c.type] || c.type}, ${c.status}${c.notes ? `. ${c.notes}` : ''}`);
      });
      lines.push('');
    }

    if ((t.blockers || []).length) {
      lines.push(`## Blocked on`, ...t.blockers.map((b) => `- ${b.text}`), ``);
    }
    if ((t.nextActions || []).length) {
      lines.push(`## Next actions`, ...t.nextActions.map((a) => `- [${a.done ? 'x' : ' '}] ${a.text}`), ``);
    }
    if (t.notes) lines.push(`## Notes`, t.notes, ``);

    lines.push(`## Effort so far`);
    lines.push(`Hours: ${t.effort.hours ?? 'not tracked'} · Tokens: ${t.effort.tokens ?? 'not tracked'} · Sessions: ${t.effort.sessions ?? 'not tracked'}`);
    lines.push('');
    lines.push(`---`);
    lines.push(`Generated from the FT Ventures development dashboard registry (${DATA.meta.updated}).`);

    return lines.filter((l) => l !== null).join('\n');
  }

  /* ============================================================ EDITS BAR */
  function renderEditsBar() {
    const bar = $('#edits-bar');
    const n = Object.keys(edits).length;
    bar.hidden = n === 0;
    if (n) {
      $('#edits-count').textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
    }
  }

  /** Edits as a compact patch, grouped by tool, ready to paste back to me. */
  function buildPatch() {
    const byTool = {};
    Object.keys(edits).forEach((k) => {
      const [id, path] = k.split('::');
      (byTool[id] = byTool[id] || {})[path] = edits[k];
    });
    const out = {
      _instruction: 'Apply these changes to dashboard/registry.json. Paths are dot-notation within each tool object.',
      _from: 'FT Ventures development dashboard, browser edits',
      changes: byTool,
    };
    return JSON.stringify(out, null, 2);
  }

  async function copy(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg || 'Copied');
    } catch {
      /* clipboard can be blocked; fall back to a selectable prompt */
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:10%;left:50%;transform:translateX(-50%);width:min(680px,90vw);height:60vh;z-index:70';
      document.body.appendChild(ta);
      ta.select();
      toast('Clipboard blocked — text selected, press Ctrl/Cmd+C then Esc');
      const cleanup = (e) => {
        if (e.type === 'keydown' && e.key !== 'Escape') return;
        ta.remove();
        document.removeEventListener('keydown', cleanup);
      };
      document.addEventListener('keydown', cleanup);
    }
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  /* ================================================================ ROUTER */
  const VIEWS = {
    overview: { label: 'Overview', icon: 'gauge', render: renderOverview, title: 'Overview' },
    tools: { label: 'Tools', icon: 'grid', render: renderTools, title: 'Tools' },
    modules: { label: 'Connections', icon: 'link', render: renderModules, title: 'Modules and connections' },
    priorities: { label: 'Priorities', icon: 'flag', render: renderPriorities, title: 'Priorities' },
    clients: { label: 'Who uses what', icon: 'users', render: renderClients, title: 'Who uses what' },
    log: { label: 'Time and tokens', icon: 'clock', render: renderLog, title: 'Time and tokens' },
  };

  function renderRail() {
    const counts = {
      tools: DATA.tools.length,
      modules: DATA.connections.length,
      clients: DATA.clients.length,
    };
    $('#nav').innerHTML = Object.entries(VIEWS).map(([k, v]) => `
      <button class="nav-item" data-route="${k}" ${route === k ? 'aria-current="page"' : ''}>
        ${icon(v.icon)}<span>${esc(v.label)}</span>
        ${counts[k] != null ? `<span class="count">${counts[k]}</span>` : ''}
      </button>`).join('');
  }

  function render() {
    renderRail();
    $('#view-title').textContent = VIEWS[route].title;
    $('#view').innerHTML = VIEWS[route].render();
    renderEditsBar();
    renderPanel();
  }

  function go(r) {
    if (!VIEWS[r]) r = 'overview';
    route = r;
    if (location.hash.slice(1) !== r) history.replaceState(null, '', '#' + r);
    render();
  }

  /* ================================================================ EVENTS */
  function wire() {
    document.addEventListener('click', (e) => {
      const navBtn = e.target.closest('[data-route]');
      if (navBtn) { go(navBtn.dataset.route); return; }

      const openBtn = e.target.closest('[data-open]');
      if (openBtn) { openToolId = openBtn.dataset.open; renderPanel(); return; }

      const dot = e.target.closest('[data-tool]');
      if (dot) { openToolId = dot.dataset.tool; renderPanel(); return; }

      const chipBtn = e.target.closest('[data-status]');
      if (chipBtn) { statusFilter = chipBtn.dataset.status; render(); return; }

      const cm = e.target.closest('[data-chartmode]');
      if (cm) {
        const id = cm.dataset.chartmode;
        chartMode[id] = (chartMode[id] || 'chart') === 'chart' ? 'table' : 'chart';
        render();
        return;
      }

      if (e.target.closest('#panel-close') || e.target.id === 'scrim') {
        openToolId = null; renderPanel(); return;
      }

      if (e.target.closest('#copy-brief')) {
        copy(buildBrief(tool(openToolId)), 'Brief copied — paste it into a new chat');
        return;
      }
      if (e.target.closest('#copy-patch')) {
        copy(buildPatch(), 'Patch copied — paste it to me and I will commit it');
        return;
      }
      if (e.target.closest('#discard-edits')) {
        if (confirm('Discard all local changes and go back to the committed registry?')) {
          edits = {}; saveEdits(); render(); toast('Local changes discarded');
        }
        return;
      }
      if (e.target.closest('#theme-toggle')) { toggleTheme(); return; }
    });

    /* editable fields inside the panel */
    document.addEventListener('input', (e) => {
      const f = e.target.closest('[data-field]');
      if (f && openToolId) {
        setEdit(openToolId, f.dataset.field, f.value);
        f.classList.toggle('edited', isEdited(openToolId, f.dataset.field));
        return;
      }
      if (e.target.id === 'q') {
        query = e.target.value;
        if (route !== 'tools') { route = 'tools'; history.replaceState(null, '', '#tools'); }
        render();
        $('#q').focus();
      }
    });

    document.addEventListener('change', (e) => {
      const f = e.target.closest('select[data-field]');
      if (f && openToolId) {
        setEdit(openToolId, f.dataset.field, f.value);
        render();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && openToolId) { openToolId = null; renderPanel(); }
      if (e.key === '/' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault(); $('#q').focus();
      }
    });

    window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'overview'));
  }

  /* ================================================================= THEME */
  function applyTheme(t) {
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    const btn = $('#theme-toggle');
    if (btn) {
      const isDark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
      btn.innerHTML = icon(isDark ? 'sun' : 'moon') + `<span>${isDark ? 'Light' : 'Dark'}</span>`;
    }
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    const isDark = cur === 'dark' || (!cur && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    try { localStorage.setItem(LS_THEME, next); } catch { /* ignore */ }
    applyTheme(next);
  }

  /* ================================================================== BOOT */
  async function boot() {
    const inline = $('#registry-data');
    if (inline) {
      DATA = JSON.parse(inline.textContent);
    } else {
      const res = await fetch('registry.json');
      DATA = await res.json();
    }

    loadEdits();
    let theme = null;
    try { theme = localStorage.getItem(LS_THEME); } catch { /* ignore */ }
    applyTheme(theme);

    $('#meta-updated').textContent = `registry ${DATA.meta.version} · ${DATA.meta.updated}`;
    wire();
    go(location.hash.slice(1) || 'overview');
  }

  boot().catch((err) => {
    document.body.innerHTML = `<div style="padding:40px;font-family:system-ui">
      <h1 style="font-size:18px">Could not load the registry</h1>
      <p style="color:#666;font-size:14px">${esc(err.message)}</p>
      <p style="color:#666;font-size:13px">If you opened this file directly from disk, the browser blocks reading
      registry.json. Use the built single-file version in <code>dashboard/dist/</code>, or serve the folder with
      <code>npx serve dashboard</code>.</p></div>`;
  });
})();
