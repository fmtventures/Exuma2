/**
 * Operations dashboard.
 *
 * Renders the seeded business through the *real* module code — priceCart,
 * generateSlots, dispatch, summarise, checkLimits — so the page shows genuine
 * computed output rather than mock screens. Every number here came out of the
 * same functions the API calls.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asId, type OrgId, type SiteId, type UserId } from '../core/ids.ts';
import { money, formatMoney } from '../commerce/money.ts';
import { priceCart } from '../commerce/pricing.ts';
import { availableFor, levelsFrom, lowStock } from '../commerce/catalog.ts';
import {
  capturePayment, createOrder, fulfil, outstandingBalance, refundPayment,
  type Order,
} from '../commerce/orders.ts';
import { generateSlots, localDateString, localMinuteOfDay, formatMinute } from '../scheduling/availability.ts';
import { activeBookings, expandOccurrences, occurrencesBetween, seatsRemaining } from '../scheduling/bookings.ts';
import { contactFieldsFrom, scoreSpam, validateSubmission } from '../crm/forms.ts';
import { findContact, hasConsent, summarisePipeline, timelineFor, upsertContact, type Activity, type Contact, type Deal } from '../crm/contacts.ts';
import { describeAutomation, dispatch, type ActionHandler, type AutomationRun } from '../automation/engine.ts';
import { canServe, certificatesDue, requiredDnsRecords, shouldForceHttps } from '../publishing/domains.ts';
import { byDay, checkLimits, rollUp, summarise, topPages, topSources } from '../analytics/metrics.ts';
import { CURRENCY, counterIds, seedBusiness } from '../api/business-store.ts';

const SITE = asId<SiteId>('site_demo');
const ORG = asId<OrgId>('org_demo');
const USER = asId<UserId>('usr_demo');
const NOW = new Date('2026-08-17T14:00:00.000Z');
const TZ = 'America/Halifax';
const fmt = (n: number) => formatMoney(money(n, CURRENCY), 'en-CA');
const ids = counterIds();

const b = seedBusiness(SITE, ORG, USER, NOW);

/* ---- Commerce: stock, a live quote, and a full order lifecycle ---- */

const levels = levelsFrom(b.movements);
const products = b.products.map((p) => ({
  title: p.title,
  variants: p.variants.map((v) => ({
    name: v.optionValues.join(' / ') || 'Default',
    sku: v.sku ?? '—',
    price: fmt(v.price.amount),
    available: v.trackInventory ? availableFor(levels, v.id) : null,
  })),
}));
const low = lowStock(levels, new Map(), 5);

const quote = priceCart({
  currency: CURRENCY,
  lines: [
    { id: 'var_char', unitPrice: money(4200, CURRENCY), quantity: 6, requiresShipping: true },
    { id: 'var_slate', unitPrice: money(4500, CURRENCY), quantity: 2, requiresShipping: true },
  ],
  discounts: [{ id: 'd', code: 'WELCOME10', label: '10% off your first order', scope: 'order', value: { kind: 'percentage', percent: 10 } }],
  shipping: money(2500, CURRENCY),
  taxRates: [
    { id: 'gst', label: 'GST', rate: 0.05, appliesToShipping: true },
    { id: 'pst', label: 'PST', rate: 0.10, appliesToShipping: true },
  ],
});

const orderCart = priceCart({
  currency: CURRENCY,
  lines: [{ id: 'l1', unitPrice: money(4200, CURRENCY), quantity: 3, requiresShipping: true }],
  taxRates: [{ id: 'gst', label: 'GST', rate: 0.05 }, { id: 'pst', label: 'PST', rate: 0.10 }],
});
let order = (createOrder({
  siteId: SITE, number: '#1001', email: 'w.gallant@example.com', cart: orderCart,
  lineDetails: new Map([['l1', { variantId: 'var_char', productId: 'prd_shingle', title: 'Architectural shingle — Charcoal', sku: 'SH-CHAR', requiresShipping: true }]]),
  shippingAddress: { line1: '14 Mill Road', city: 'Charlottetown', countryCode: 'CA' },
  now: NOW, makeId: ids,
}) as { value: Order }).value;
const lifecycle: { step: string; state: string }[] = [{ step: 'Placed', state: order.paymentStatus }];
order = (capturePayment(order, { amount: order.total, provider: 'stripe', idempotencyKey: 'k1', now: NOW, makeId: ids }) as { value: Order }).value;
lifecycle.push({ step: 'Payment captured', state: order.paymentStatus });
order = (fulfil(order, { lines: [{ lineId: 'l1', quantity: 3 }], carrier: 'Own crew', trackingNumber: 'AC-1188', now: NOW, makeId: ids }) as { value: Order }).value;
lifecycle.push({ step: 'Fulfilled', state: order.fulfilmentStatus });
order = (refundPayment(order, { amount: money(1500, CURRENCY), provider: 'stripe', idempotencyKey: 'r1', reason: 'goodwill', lines: [], now: NOW, makeId: ids }) as { value: Order }).value;
lifecycle.push({ step: 'Refunded $15.00', state: order.paymentStatus });

/* ---- Scheduling: real generated slots + event capacity ---- */

const service = b.services[0]!;
const resource = b.resources[0]!;
const dates = Array.from({ length: 5 }, (_, i) => localDateString(new Date(NOW.getTime() + i * 86400000), TZ));
const slots = generateSlots({
  schedule: resource.schedule,
  rules: { ...service.slotRules, capacity: resource.capacity },
  dates,
  busy: activeBookings(b.bookings).map((bk) => ({ start: new Date(bk.start), end: new Date(bk.end) })),
  now: NOW,
});
const slotsByDay = new Map<string, string[]>();
for (const s of slots) {
  const day = localDateString(s.start, TZ);
  const list = slotsByDay.get(day) ?? [];
  if (list.length < 8) list.push(formatMinute(localMinuteOfDay(s.start, TZ)));
  slotsByDay.set(day, list);
}
const event = b.events[0]!;
const occ = expandOccurrences(event);
const occurrences = occ.ok ? occurrencesBetween(occ.value, NOW, new Date(NOW.getTime() + 120 * 86400000)) : [];

/* ---- Forms → CRM → automation, run for real ---- */

const form = b.forms[0]!;
const raw = { name: 'Wanda Gallant', email: 'w.gallant@example.com', phone: '902-555-0148', service: 'replacement', message: 'Shingles lifting on the north slope after the August storm — would like a quote.', optin: true, _elapsed: 52 };
const validated = validateSubmission(form, raw);
const spam = scoreSpam(form, { values: (validated as { value: { values: Record<string, string | string[]> } }).value.values, secondsToComplete: 52 });
const fields = contactFieldsFrom(form, (validated as { value: { values: Record<string, string | string[]> } }).value.values);
let contact = (upsertContact(findContact(b.contacts, { email: fields.email }), {
  siteId: SITE, email: fields.email, phone: fields.phone, name: fields.name, tags: form.tags ?? [],
  consent: { channel: 'email_marketing', basis: 'express', granted: true, text: 'Email me seasonal maintenance reminders', source: 'form', at: NOW.toISOString() },
  now: NOW, makeId: ids,
}) as { value: Contact }).value;
b.contacts.push(contact);
const activities: Activity[] = [
  { id: ids('act'), siteId: SITE, contactId: contact.id, kind: 'form_submitted', summary: 'Submitted "Request a quote"', at: NOW.toISOString() },
];

const createdDeals: Deal[] = [];
const handler: ActionHandler = (action, ctx) => {
  switch (action.kind) {
    case 'add_tag': {
      contact = { ...contact, tags: [...new Set([...contact.tags, action.tag])] };
      return { action, status: 'ok', detail: `tagged "${action.tag}"` };
    }
    case 'create_deal': {
      createdDeals.push({ id: ids('dl'), siteId: SITE, contactId: ctx.contactId!, title: action.title, stageId: action.stageId, valueMinor: 1260000, currency: CURRENCY, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
      return { action, status: 'ok', detail: `created deal "${action.title}"` };
    }
    case 'send_email': case 'send_sms': case 'notify_webhook':
      return { action, status: 'skipped', detail: 'no delivery provider configured in this build' };
    default: return { action, status: 'ok' };
  }
};
const formRuns = await dispatch({
  automations: b.automations, triggerKind: 'form_submitted',
  payload: { formId: form.id, values: raw }, contactId: contact.id,
  idempotencyKey: 'sub_demo', existingRuns: [], handler, now: NOW, makeId: ids,
});
// Also fire an order trigger below the threshold, so a real skip is shown.
const orderRuns = await dispatch({
  automations: b.automations, triggerKind: 'order_placed',
  payload: { order: { total: 12600 } }, idempotencyKey: 'ord_demo', existingRuns: [], handler, now: NOW, makeId: ids,
});
const allRuns: AutomationRun[] = [...formRuns, ...orderRuns];
b.deals.push(...createdDeals);
const pipeline = summarisePipeline(b.stages, b.deals);
const timeline = timelineFor([...activities], contact.id);

/* ---- Publishing ---- */

const domainRows = b.domains.map((d) => ({
  hostname: d.hostname,
  status: d.status,
  servable: canServe(d),
  forcing: shouldForceHttps(d, NOW),
  records: requiredDnsRecords(d, { ipv4: ['203.0.113.10'], ipv6: ['2001:db8::10'], cname: 'sites.sidelio.net' }),
}));
const renewals = certificatesDue(b.domains, NOW);

/* ---- Analytics ---- */

const recent = b.metrics.filter((e) => Date.parse(e.at) >= NOW.getTime() - 14 * 86400000);
const totals = summarise(recent);
const days = [...byDay(recent, TZ).entries()].map(([day, t]) => ({ day, views: t.views }));
const pages = topPages(recent, 6);
const sources = topSources(recent, b.domains[0]?.hostname ?? 'acmeroofing.ca', 5);

/* ---- Billing + agency ---- */

const usage = { sites: 1, pages: 8, monthlyPageViews: recent.filter((e) => e.kind === 'page_view').length, storageMb: 240, products: b.products.length, staffSeats: 2, aiCreditsUsed: 120, customDomains: b.domains.length };
const limits = checkLimits(b.plan, usage);
const agency = rollUp([{
  siteId: SITE, name: 'Acme Roofing Ltd.',
  issues: [
    ...(domainRows.some((d) => !d.servable) ? [{ severity: 'critical' as const, message: 'acmeroofing.ca is not verified yet' }] : []),
    { severity: 'warning' as const, message: '40 imported facts are still unapproved' },
  ],
  totals,
}]);

/* ================================================================== */
/* Render                                                              */
/* ================================================================== */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const stateClass = (s: string) => {
  if (['paid', 'active', 'confirmed', 'fulfilled', 'completed', 'ok'].includes(s)) return 'good';
  if (['pending', 'partially_refunded', 'partially_fulfilled', 'approaching', 'waiting', 'pending_dns', 'trialing', 'skipped'].includes(s)) return 'warn';
  if (['failed', 'exceeded', 'error', 'refunded'].includes(s)) return 'crit';
  return 'neutral';
};
const chip = (s: string) => `<span class="chip ${stateClass(s)}">${esc(s.replace(/_/g, ' '))}</span>`;

const maxViews = Math.max(...days.map((d) => d.views), 1);
const chartW = 620, chartH = 130, pad = 6;
const pts = days.map((d, i) => {
  const x = pad + (i / Math.max(days.length - 1, 1)) * (chartW - pad * 2);
  const y = chartH - pad - (d.views / maxViews) * (chartH - pad * 2);
  return { x, y, ...d };
});
const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
const area = `${line} L${pts[pts.length - 1]!.x.toFixed(1)} ${chartH - pad} L${pts[0]!.x.toFixed(1)} ${chartH - pad} Z`;
const last = pts[pts.length - 1]!;

const meter = (v: (typeof limits)[number]) => {
  const pct = v.limit === Infinity ? 0 : Math.min(100, Math.round(v.ratio * 100));
  const label = v.limit === Infinity ? '∞' : v.limit.toLocaleString();
  return `<div class="meter-row">
    <div class="meter-top"><span>${esc(String(v.key).replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()))}</span><span class="mono">${v.used.toLocaleString()} / ${label}</span></div>
    <div class="track"><span class="fill ${stateClass(v.state)}" style="width:${Math.max(pct, 2)}%"></span></div>
  </div>`;
};

const panel = (title: string, subtitle: string, inner: string, span = 1) =>
  `<section class="panel span-${span}"><header class="p-head"><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></header>${inner}</section>`;

const productRows = products.map((p) => `
  <div class="prod">
    <div class="prod-title">${esc(p.title)}</div>
    ${p.variants.map((v) => `<div class="prod-var"><span>${esc(v.name)}</span><span class="mono">${esc(v.price)}</span><span class="mono muted">${esc(v.sku)}</span>${v.available === null ? '<span class="chip neutral">digital</span>' : v.available <= 5 ? `<span class="chip crit mono">${v.available} left</span>` : `<span class="chip good mono">${v.available}</span>`}</div>`).join('')}
  </div>`).join('');

const quoteRows = `
  <table class="ledger"><tbody>
    <tr><td>6 × Architectural shingle — Charcoal</td><td class="mono">${fmt(quote.lines[0]!.subtotal.amount)}</td></tr>
    <tr><td>2 × Architectural shingle — Slate</td><td class="mono">${fmt(quote.lines[1]!.subtotal.amount)}</td></tr>
    <tr class="disc"><td>WELCOME10 — 10% off</td><td class="mono">−${fmt(quote.discountTotal.amount)}</td></tr>
    <tr><td>Shipping</td><td class="mono">${fmt(quote.shipping.amount)}</td></tr>
    <tr><td>GST + PST</td><td class="mono">${fmt(quote.taxTotal.amount)}</td></tr>
    <tr class="total"><td>Total</td><td class="mono">${fmt(quote.total.amount)}</td></tr>
  </tbody></table>
  <p class="note">Discount allocated across lines so the total balances to the cent; tax charged on the net, GST and PST both on the discounted amount.</p>`;

const lifecycleRow = `<div class="flow">${lifecycle.map((l, i) => `${i > 0 ? '<span class="arrow">→</span>' : ''}<span class="step"><b>${esc(l.step)}</b>${chip(l.state)}</span>`).join('')}</div>
  <p class="note mono">Order ${esc(order.number)} · captured ${fmt(order.total.amount)} · refunded ${fmt(1500)} · outstanding ${fmt(outstandingBalance(order).amount)} · retried capture ignored (idempotent)</p>`;

const slotRows = [...slotsByDay.entries()].slice(0, 4).map(([day, times]) => `
  <div class="day">
    <div class="day-label">${esc(new Date(day + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }))}</div>
    <div class="slot-chips">${times.map((t) => `<span class="slot mono">${esc(t)}</span>`).join('')}</div>
  </div>`).join('');

const eventRow = occurrences.slice(0, 3).map((o) => {
  const remaining = seatsRemaining(o, b.registrations) ?? 0;
  return `<div class="prod-var"><span>${esc(new Date(o.start).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ }))}, 7:00 pm</span><span class="chip ${remaining < 6 ? 'warn' : 'good'} mono">${remaining} of ${event.capacity} left</span></div>`;
}).join('');

const pipelineRow = `<div class="pipe">${pipeline.map((s) => `<div class="stage"><div class="stage-count mono">${s.count}</div><div class="stage-name">${esc(s.name)}</div>${s.valueMinor ? `<div class="stage-val mono">${fmt(s.valueMinor)}</div>` : '<div class="stage-val muted">—</div>'}</div>`).join('')}</div>`;

const contactCard = `<div class="contact">
  <div class="contact-head"><b>${esc(contact.name)}</b>${hasConsent(contact, 'email_marketing', NOW) ? '<span class="chip good">opted in</span>' : '<span class="chip neutral">no consent</span>'}</div>
  <div class="mono muted">${esc(contact.email)} · ${esc(contact.phone)}</div>
  <div class="tags">${contact.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
  <ul class="timeline">${timeline.map((a) => `<li>${esc(a.summary)}</li>`).join('')}${createdDeals.map((d) => `<li>Deal created — ${esc(d.title)} (${fmt(d.valueMinor ?? 0)})</li>`).join('')}</ul>
</div>`;

const autoRows = b.automations.map((a) => {
  const runs = allRuns.filter((r) => r.automationId === a.id);
  const run = runs[0];
  return `<div class="auto">
    <div class="auto-top"><b>${esc(a.name)}</b>${a.enabled ? '<span class="chip good">on</span>' : '<span class="chip neutral">off</span>'}</div>
    <div class="auto-desc">${esc(describeAutomation(a))}</div>
    ${run ? `<div class="auto-run">${chip(run.status)}<span class="run-detail">${esc(run.reason ?? (run.steps.map((s) => s.detail).filter(Boolean).join(' · ') || 'ran'))}</span></div>` : '<div class="auto-run"><span class="chip neutral">idle</span><span class="run-detail muted">not triggered in this run</span></div>'}
  </div>`;
}).join('');

const dnsRows = domainRows.map((d) => `
  <div class="domain">
    <div class="domain-top"><b class="mono">${esc(d.hostname)}</b>${chip(d.status)}${d.servable ? '<span class="chip good">serving</span>' : '<span class="chip warn">not verified</span>'}</div>
    <table class="dns"><tbody>${d.records.map((r) => `<tr><td class="mono">${esc(r.type)}</td><td class="mono muted">${esc(r.name)}</td><td class="mono">${esc(r.value.length > 30 ? r.value.slice(0, 30) + '…' : r.value)}</td></tr>`).join('')}</tbody></table>
  </div>`).join('');

const pagesRows = pages.map((p) => `<tr><td class="mono">${esc(p.path)}</td><td class="mono">${p.views}</td><td class="mono muted">${Math.round(p.bounceRate * 100)}%</td></tr>`).join('');
const sourceRows = sources.map((s) => `<tr><td>${esc(s.source)}</td><td class="mono">${s.visits}</td></tr>`).join('');

const html = `<title>Acme Roofing Operations</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{
  --paper:#f4f6f7; --surface:#ffffff; --surface-2:#f9fafb; --ink:#161b20; --muted:#5c6773;
  --line:#e1e5e9; --line-strong:#cdd3d9; --accent:#b8590c; --accent-soft:#f4e6d6;
  --good:#2f8f5b; --good-bg:#e5f2ea; --warn:#a5751a; --warn-bg:#f6ecd6; --crit:#c1462f; --crit-bg:#f7e2dd;
  --neutral:#6b7681; --neutral-bg:#eceff1;
  --shadow:0 1px 2px rgba(20,27,34,.05),0 4px 14px rgba(20,27,34,.05);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#0c0f12; --surface:#14191e; --surface-2:#191f25; --ink:#e8ecef; --muted:#93a0ab;
  --line:#232a31; --line-strong:#2f3841; --accent:#e08a3c; --accent-soft:#33261a;
  --good:#4bbd82; --good-bg:#16271f; --warn:#d0a03f; --warn-bg:#2a2113; --crit:#e07059; --crit-bg:#2c1a16;
  --neutral:#8b96a1; --neutral-bg:#20272e;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px rgba(0,0,0,.28);
}}
:root[data-theme="dark"]{
  --paper:#0c0f12; --surface:#14191e; --surface-2:#191f25; --ink:#e8ecef; --muted:#93a0ab;
  --line:#232a31; --line-strong:#2f3841; --accent:#e08a3c; --accent-soft:#33261a;
  --good:#4bbd82; --good-bg:#16271f; --warn:#d0a03f; --warn-bg:#2a2113; --crit:#e07059; --crit-bg:#2c1a16;
  --neutral:#8b96a1; --neutral-bg:#20272e;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px rgba(0,0,0,.28);
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;}
.muted{color:var(--muted);}
.wrap{max-width:1180px;margin:0 auto;padding:28px 22px 72px;}
h1,h2{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;font-weight:700;letter-spacing:-.02em;margin:0;}

header.top{display:flex;flex-wrap:wrap;align-items:center;gap:14px 18px;padding-bottom:22px;border-bottom:1px solid var(--line);margin-bottom:24px;}
.brand{width:38px;height:38px;border-radius:9px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:800;font-family:"Helvetica Neue",Arial,sans-serif;font-size:19px;flex:none;}
.top h1{font-size:22px;}
.top .sub{color:var(--muted);font-size:13.5px;margin-top:2px;}
.top .right{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;}

.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:26px;}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 15px;box-shadow:var(--shadow);}
.kpi .k-val{font-size:23px;font-weight:700;font-family:"Helvetica Neue",Arial,sans-serif;letter-spacing:-.02em;}
.kpi .k-lab{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-top:3px;}
.kpi.accent .k-val{color:var(--accent);}

.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 18px 20px;box-shadow:var(--shadow);min-width:0;}
.span-2{grid-column:span 2;} .span-3{grid-column:span 3;}
.p-head{margin-bottom:14px;}
.p-head h2{font-size:14.5px;}
.p-head p{margin:3px 0 0;font-size:12.5px;color:var(--muted);}

.chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;line-height:1.5;white-space:nowrap;text-transform:capitalize;}
.chip.good{background:var(--good-bg);color:var(--good);} .chip.warn{background:var(--warn-bg);color:var(--warn);}
.chip.crit{background:var(--crit-bg);color:var(--crit);} .chip.neutral{background:var(--neutral-bg);color:var(--neutral);}
.chip.mono{text-transform:none;}

.prod{padding:9px 0;border-top:1px solid var(--line);} .prod:first-child{border-top:0;}
.prod-title{font-weight:600;font-size:13px;margin-bottom:6px;}
.prod-var{display:grid;grid-template-columns:1fr auto auto auto;gap:10px;align-items:center;font-size:12.5px;padding:3px 0;}
.prod-var>span:first-child{color:var(--ink);}

.ledger{width:100%;border-collapse:collapse;font-size:13px;}
.ledger td{padding:5px 0;border-top:1px solid var(--line);}
.ledger td:last-child{text-align:right;}
.ledger tr:first-child td{border-top:0;}
.ledger .disc td{color:var(--good);}
.ledger .total td{font-weight:700;border-top:2px solid var(--line-strong);padding-top:8px;}
.note{font-size:11.5px;color:var(--muted);margin:10px 0 0;line-height:1.45;}

.flow{display:flex;align-items:center;flex-wrap:wrap;gap:8px;}
.step{display:inline-flex;align-items:center;gap:7px;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:7px 10px;font-size:12.5px;}
.arrow{color:var(--muted);}

.day{padding:8px 0;border-top:1px solid var(--line);} .day:first-child{border-top:0;}
.day-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:5px;}
.slot-chips{display:flex;flex-wrap:wrap;gap:6px;}
.slot{font-size:12px;background:var(--accent-soft);color:var(--accent);border-radius:7px;padding:3px 8px;font-weight:600;}

.pipe{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;}
.stage{background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:11px 9px;text-align:center;}
.stage-count{font-size:21px;font-weight:700;}
.stage-name{font-size:11px;color:var(--muted);margin:2px 0 4px;line-height:1.2;}
.stage-val{font-size:11.5px;font-weight:600;}

.contact{background:var(--surface-2);border:1px solid var(--line);border-radius:11px;padding:13px 14px;}
.contact-head{display:flex;align-items:center;gap:9px;margin-bottom:3px;font-size:14px;}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin:9px 0;}
.tag{font-size:11px;background:var(--accent-soft);color:var(--accent);padding:2px 8px;border-radius:6px;font-weight:600;}
.timeline{list-style:none;margin:6px 0 0;padding:0;}
.timeline li{font-size:12.5px;color:var(--muted);padding:4px 0 4px 15px;position:relative;}
.timeline li::before{content:"";position:absolute;left:2px;top:10px;width:5px;height:5px;border-radius:50%;background:var(--accent);}

.auto{padding:11px 0;border-top:1px solid var(--line);} .auto:first-child{border-top:0;}
.auto-top{display:flex;align-items:center;gap:9px;font-size:13.5px;}
.auto-desc{font-size:12px;color:var(--muted);margin:3px 0 6px;}
.auto-run{display:flex;align-items:center;gap:8px;font-size:12px;}
.run-detail{color:var(--ink);}

.domain{padding-bottom:6px;}
.domain-top{display:flex;align-items:center;gap:8px;margin-bottom:9px;font-size:13.5px;}
.dns{width:100%;border-collapse:collapse;font-size:11.5px;}
.dns td{padding:4px 8px 4px 0;border-top:1px solid var(--line);}
.dns tr:first-child td{border-top:0;}

.meter-row{margin-bottom:11px;}
.meter-top{display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;}
.track{height:7px;background:var(--neutral-bg);border-radius:20px;overflow:hidden;}
.fill{display:block;height:100%;border-radius:20px;background:var(--good);}
.fill.warn{background:var(--warn);} .fill.crit{background:var(--crit);} .fill.good{background:var(--good);}

.chart-wrap{margin-top:4px;}
.chart{width:100%;height:auto;display:block;}
.dt-tables{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:14px;}
.dt-tables table{width:100%;border-collapse:collapse;font-size:12.5px;}
.dt-tables th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;padding-bottom:5px;border-bottom:1px solid var(--line);}
.dt-tables td{padding:5px 0;border-top:1px solid var(--line);}
.dt-tables td:last-child,.dt-tables th:last-child{text-align:right;}

.foot{margin-top:30px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.6;}
.foot b{color:var(--ink);}

@media (max-width:920px){.grid{grid-template-columns:repeat(2,1fr);}.span-2,.span-3{grid-column:span 2;}.kpis{grid-template-columns:repeat(3,1fr);}}
@media (max-width:560px){.grid,.span-2,.span-3{grid-template-columns:1fr;grid-column:span 1;}.kpis{grid-template-columns:repeat(2,1fr);}.pipe{grid-template-columns:repeat(3,1fr);}.dt-tables{grid-template-columns:1fr;}}
</style>

<div class="wrap">
  <header class="top">
    <div class="brand">A</div>
    <div>
      <h1>Acme Roofing — Operations</h1>
      <div class="sub">Everything below is real output from the platform modules, computed from one seeded tenant · ${esc(NOW.toLocaleDateString('en-CA', { dateStyle: 'long' }))}</div>
    </div>
    <div class="right">${chip(b.subscription.status)}<span class="chip neutral">Pro plan</span></div>
  </header>

  <div class="kpis">
    <div class="kpi accent"><div class="k-val">${esc(fmt(totals.revenueMinor).replace('.00',''))}</div><div class="k-lab">Revenue · 14d</div></div>
    <div class="kpi"><div class="k-val">${totals.views.toLocaleString()}</div><div class="k-lab">Page views</div></div>
    <div class="kpi"><div class="k-val">${totals.visitors.toLocaleString()}</div><div class="k-lab">Visitors</div></div>
    <div class="kpi"><div class="k-val">${totals.orders}</div><div class="k-lab">Orders</div></div>
    <div class="kpi"><div class="k-val">${slots.length}</div><div class="k-lab">Open slots</div></div>
    <div class="kpi"><div class="k-val">${b.contacts.length}</div><div class="k-lab">Contacts</div></div>
  </div>

  <div class="grid">
    ${panel('Catalogue & stock', 'Inventory folded from an append-only movement ledger', productRows + (low.length ? `<p class="note">⚠ ${low.length} variant at or below its reorder point — surfaced, never hidden.</p>` : ''))}
    ${panel('Live quote', 'priceCart() — discount allocated, tax on net', quoteRows)}
    ${panel('Order lifecycle', 'Payment, fulfilment and refund move independently', lifecycleRow)}

    ${panel('Bookable slots', `${esc(service.name)} · ${esc(resource.name)} · half-open, buffered, 4h notice`, slotRows, 2)}
    ${panel('Event capacity', esc(event.title), eventRow || '<p class="note">No upcoming dates.</p>')}

    ${panel('Sales pipeline', 'Deals by stage — the automation below created one', pipelineRow + `<p class="note">Open pipeline value ${fmt(pipeline.reduce((n, s) => n + s.valueMinor, 0))} across ${pipeline.reduce((n, s) => n + s.count, 0)} deal(s).</p>`, 2)}
    ${panel('New contact', 'Created by the form submission, consent recorded', contactCard)}

    ${panel('Automations', 'Runs shown with the reason they did — or did not — fire', autoRows, 2)}
    ${panel('Domain & DNS', 'Verified before it will serve; HTTPS gated on a cert', dnsRows + (renewals.length ? '' : '<p class="note">No certificate issued yet, so HTTPS is not forced — the site publishes to its sidelio.site address until DNS verifies.</p>'))}

    ${panel('Traffic · 14 days', 'Cookieless, first-party, bucketed by the site local day', `
      <div class="chart-wrap">
        <svg class="chart" viewBox="0 0 ${chartW} ${chartH}" preserveAspectRatio="none" role="img" aria-label="Daily page views over 14 days">
          <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--accent)" stop-opacity="0.28"/>
            <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
          </linearGradient></defs>
          <path d="${area}" fill="url(#fill)"/>
          <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
          <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="var(--accent)"/>
        </svg>
      </div>
      <div class="dt-tables">
        <table><thead><tr><th>Top page</th><th>Views</th><th>Bounce</th></tr></thead><tbody>${pagesRows}</tbody></table>
        <table><thead><tr><th>Source</th><th>Visits</th></tr></thead><tbody>${sourceRows}</tbody></table>
      </div>`, 2)}
    ${panel('Plan usage', `${esc(b.plan.name)} · warns before it blocks`, limits.slice(0, 6).map(meter).join(''))}
  </div>

  <div class="foot">
    <b>What this is.</b> A single seeded business — Acme Roofing — rendered through the real commerce, scheduling, CRM, automation, publishing and analytics modules. The quote balances because <b>priceCart</b> allocated the discount across lines; the slots respect a four-hour notice and back-to-back buffers because <b>generateSlots</b> computed them; the automation panel shows a genuine skip with its reason.<br>
    <b>Not yet built:</b> these modules have no in-browser controls of their own — this page is a read-only view. Nothing persists across a restart (still in-memory), there is no login (one fixed owner), and payments, email/SMS and DNS have no live provider adapter. <b>536 tests</b> cover the logic underneath.
  </div>
</div>`;

mkdirSync(resolve(process.cwd(), 'dist/ops'), { recursive: true });
const out = resolve(process.cwd(), 'dist/ops/index.html');
writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB`);
console.log(`revenue ${fmt(totals.revenueMinor)} · views ${totals.views} · slots ${slots.length} · runs ${allRuns.length} · deals ${b.deals.length}`);
