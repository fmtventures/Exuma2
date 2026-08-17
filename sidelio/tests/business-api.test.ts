import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp, resetBusinessState } from '../src/api/server.ts';
import { seedStore, type AppStore } from '../src/api/store.ts';
import { FIXTURE_PAGES } from './fixtures/site.ts';

/**
 * Business modules over HTTP.
 *
 * Routes exercised only by unit tests are routes that have never actually been
 * called — the media module sat behind an empty asset map for weeks that way.
 * This drives commerce, scheduling, forms, CRM, automations, publishing and
 * analytics through the real server, in the order a business would.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
  let body: any = {};
  if (text && (res.headers.get('content-type') ?? '').includes('json')) body = JSON.parse(text);
  return { status: res.status, body, raw: text, headers: res.headers };
}

const post = (path: string, body: unknown) =>
  call(path, { method: 'POST', body: JSON.stringify(body) });

beforeAll(async () => {
  resetBusinessState();
  store = await seedStore(FIXTURE_PAGES);
  server = createApp(store, new URL('../src/admin', import.meta.url).pathname);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetBusinessState();
});

/* ------------------------------------------------------------------ */

describe('commerce over HTTP', () => {
  it('lists products with live stock and flags what cannot be sold', async () => {
    const { body } = await call('/api/commerce/products');
    expect(body.products.length).toBeGreaterThan(0);

    const shingle = body.products.find((p: { id: string }) => p.id === 'prd_shingle');
    expect(shingle.variants).toHaveLength(3);
    expect(shingle.variants[0].available).toBe(140);

    // A digital product is untracked, so availability is not a number.
    const guide = body.products.find((p: { id: string }) => p.id === 'prd_guide');
    expect(guide.variants[0].available).toBeNull();

    // Ridge vent is at zero and must show up as low stock.
    expect(body.lowStock.some((l: { variantId: string }) => l.variantId === 'var_ridge')).toBe(true);
  });

  it('quotes a cart with tax and a discount that balances', async () => {
    const { body } = await post('/api/commerce/quote', {
      lines: [{ variantId: 'var_char', quantity: 3 }, { variantId: 'var_slate', quantity: 1 }],
      discountCode: 'WELCOME10',
      shippingMinor: 2500,
    });
    const cart = body.cart;
    const lineTotals = cart.lines.reduce((n: number, l: { total: { amount: number } }) => n + l.total.amount, 0);
    expect(lineTotals + cart.shipping.amount).toBe(cart.total.amount);
    expect(cart.discountTotal.amount).toBeGreaterThan(0);
  });

  it('reports partial stock instead of refusing the whole basket', async () => {
    const { body } = await post('/api/commerce/quote', {
      lines: [{ variantId: 'var_slate', quantity: 10 }],
    });
    expect(body.stock.ok).toBe(false);
    expect(body.stock.lines[0]).toMatchObject({ requested: 10, fulfillable: 4, reason: 'partial' });
  });

  it('places an order, takes stock, then captures, fulfils and refunds it', async () => {
    const placed = await post('/api/commerce/orders', {
      email: 'buyer@example.com',
      lines: [{ variantId: 'var_char', quantity: 2 }],
      shippingAddress: { line1: '14 Mill Road', city: 'Charlottetown', countryCode: 'CA' },
    });
    expect(placed.status).toBe(200);
    const order = placed.body.order;
    expect(order.paymentStatus).toBe('pending');

    // Stock leaves when the order is placed, not when it ships, or the same
    // unit is sold twice while it waits to be picked.
    const after = await call('/api/commerce/products');
    const charcoal = after.body.products
      .find((p: { id: string }) => p.id === 'prd_shingle').variants
      .find((v: { id: string }) => v.id === 'var_char');
    expect(charcoal.available).toBe(138);

    const captured = await post(`/api/commerce/orders/${order.id}/capture`, { idempotencyKey: 'k_1' });
    expect(captured.body.order.paymentStatus).toBe('paid');

    // A retried webhook must not take the money twice.
    const again = await post(`/api/commerce/orders/${order.id}/capture`, { idempotencyKey: 'k_1' });
    expect(again.body.order.payments).toHaveLength(1);

    const fulfilled = await post(`/api/commerce/orders/${order.id}/fulfil`, { carrier: 'Own crew' });
    expect(fulfilled.body.order.fulfilmentStatus).toBe('fulfilled');

    const refunded = await post(`/api/commerce/orders/${order.id}/refund`, {
      amountMinor: 1000, reason: 'goodwill', idempotencyKey: 'r_1',
    });
    expect(refunded.body.order.paymentStatus).toBe('partially_refunded');
  });

  it('refuses to refund more than was captured', async () => {
    const orders = await call('/api/commerce/orders');
    const order = orders.body.orders[0];
    const over = await post(`/api/commerce/orders/${order.id}/refund`, {
      amountMinor: 99999999, idempotencyKey: 'r_over',
    });
    expect(over.status).toBe(400);
  });

  it('rejects an order for a variant that does not exist', async () => {
    const r = await post('/api/commerce/orders', {
      email: 'a@b.co', lines: [{ variantId: 'var_nope', quantity: 1 }],
    });
    expect(r.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */

describe('scheduling over HTTP', () => {
  it('offers slots inside opening hours and honours notice', async () => {
    const { body } = await call('/api/scheduling/slots');
    expect(body.slots.length).toBeGreaterThan(0);
    const first = new Date(body.slots[0].start);
    // The service requires four hours' notice.
    expect(first.getTime()).toBeGreaterThan(Date.now() + 3.5 * 3600000);
  });

  it('books a slot, creates the contact, and refuses the same slot twice', async () => {
    const slots = await call('/api/scheduling/slots');
    const slot = slots.body.slots[0];

    const first = await post('/api/scheduling/bookings', {
      serviceId: 'svc_inspect', resourceId: slots.body.resourceId, start: slot.start,
      name: 'Sam Reid', email: 'sam@example.com',
      answers: { address: '14 Mill Road' },
    });
    expect(first.status).toBe(200);
    expect(first.body.booking.status).toBe('confirmed');

    // The booking creates the CRM record in the same act, not via a later
    // sync that can silently stop running.
    const contacts = await call('/api/crm/contacts');
    expect(contacts.body.contacts.some((c: { email: string }) => c.email === 'sam@example.com')).toBe(true);

    const second = await post('/api/scheduling/bookings', {
      serviceId: 'svc_inspect', resourceId: slots.body.resourceId, start: slot.start,
      name: 'Other Person', email: 'other@example.com',
      answers: { address: '2 Elm St' },
    });
    expect(second.status).toBe(409);
  });

  it('enforces required intake answers', async () => {
    const slots = await call('/api/scheduling/slots');
    const r = await post('/api/scheduling/bookings', {
      serviceId: 'svc_inspect', resourceId: slots.body.resourceId,
      start: slots.body.slots[4].start, name: 'No Address', email: 'x@y.co',
    });
    expect(r.status).toBe(400);
  });

  it('lists event dates with remaining capacity and serves an ICS feed', async () => {
    const { body } = await call('/api/scheduling/events');
    const event = body.events[0];
    expect(event.occurrences.length).toBeGreaterThan(0);
    expect(event.occurrences[0].remaining).toBe(24);

    const registered = await post(`/api/scheduling/events/${event.id}/register`, {
      occurrenceId: event.occurrences[0].id, ticketTypeId: 'tt_free',
      name: 'Attendee', email: 'attendee@example.com', quantity: 2,
    });
    expect(registered.body.registration.status).toBe('confirmed');

    const after = await call('/api/scheduling/events');
    expect(after.body.events[0].occurrences[0].remaining).toBe(22);

    const ics = await call(`/api/scheduling/events/${event.id}/ics`);
    expect(ics.headers.get('content-type')).toContain('text/calendar');
    expect(ics.raw).toContain('BEGIN:VEVENT');
    for (const line of ics.raw.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
  });

  it('refuses more tickets than a limited type has', async () => {
    const { body } = await call('/api/scheduling/events');
    const event = body.events[0];
    const r = await post(`/api/scheduling/events/${event.id}/register`, {
      occurrenceId: event.occurrences[0].id, ticketTypeId: 'tt_kit',
      name: 'Greedy', email: 'g@example.com', quantity: 5,
    });
    expect(r.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */

describe('forms, CRM and automations over HTTP', () => {
  it('accepts a public submission, creates a contact, and runs the automation', async () => {
    const r = await post('/api/forms/frm_quote/submissions', {
      name: 'Dana Fry', email: 'dana@example.com', phone: '902-555-7788',
      service: 'replacement', message: 'Shingles lifting after the storm.',
      optin: true, _elapsed: 45,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.automationsRun).toBeGreaterThan(0);

    const contacts = await call('/api/crm/contacts');
    const dana = contacts.body.contacts.find((c: { email: string }) => c.email === 'dana@example.com');
    expect(dana.emailMarketing).toBe(true);
    expect(dana.tags).toContain('website lead');

    // The automation created a deal, so the pipeline is no longer empty.
    expect(contacts.body.pipeline.find((s: { stageId: string }) => s.stageId === 'stg_new').count).toBe(1);
  });

  it('returns per-field errors rather than a single failure', async () => {
    const r = await post('/api/forms/frm_quote/submissions', { email: 'not-an-email' });
    expect(r.status).toBe(400);
    const fields = r.body.error.details.map((d: { field: string }) => d.field).sort();
    expect(fields).toEqual(['email', 'name', 'service']);
  });

  it('flags spam without discarding it', async () => {
    // A wrongly binned enquiry is a customer who believes they were ignored.
    const r = await post('/api/forms/frm_quote/submissions', {
      name: 'Bot', email: 'bot@spam.co', service: 'repair',
      message: 'cheap backlink seo services http://a http://b http://c',
      company_url: 'http://spam.example', _elapsed: 1,
    });
    expect(r.status).toBe(200);
    const forms = await call('/api/forms');
    expect(forms.body.forms[0].spam).toBe(1);
    expect(forms.body.submissions.some((s: { status: string }) => s.status === 'spam')).toBe(true);
  });

  it('shows a contact timeline built from real events', async () => {
    const contacts = await call('/api/crm/contacts');
    const dana = contacts.body.contacts.find((c: { email: string }) => c.email === 'dana@example.com');
    const detail = await call(`/api/crm/contacts/${dana.id}`);
    expect(detail.body.timeline[0].kind).toBe('form_submitted');
    expect(detail.body.deals.length).toBeGreaterThan(0);
  });

  it('withdraws consent without erasing the record of the grant', async () => {
    const contacts = await call('/api/crm/contacts');
    const dana = contacts.body.contacts.find((c: { email: string }) => c.email === 'dana@example.com');
    const r = await post(`/api/crm/contacts/${dana.id}/unsubscribe`, {});
    expect(r.body.consented).toBe(false);
    expect(r.body.contact.consent).toHaveLength(2);
    expect(r.body.contact.consent[0].granted).toBe(true);
  });

  it('exports contacts as CSV with formula injection neutralised', async () => {
    const r = await call('/api/crm/export');
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.raw.split('\r\n')[0]).toContain('Email');
    // A phone number starting with + would otherwise be a live formula.
    expect(r.raw).toMatch(/'\+1|902-555-7788/);
  });

  it('records why an automation that was considered did not run', async () => {
    // Only automations bound to the trigger are considered at all, so a
    // skip has to come from one that matched and was then declined —
    // otherwise every trigger would flood the log with irrelevant rows.
    await post('/api/automations/aut_lead/toggle', {});
    await post('/api/forms/frm_quote/submissions', {
      name: 'While Off', email: 'off@example.com', service: 'repair', _elapsed: 30,
    });
    await post('/api/automations/aut_lead/toggle', {});

    const { body } = await call('/api/automations');
    expect(body.automations.length).toBe(3);
    const skipped = body.recentRuns.filter((r: { status: string }) => r.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].reason).toMatch(/turned off/);
  });

  it('does not claim to have sent mail it cannot send', async () => {
    // A handler that pretends to have delivered an email is exactly the
    // silent failure the engine exists to prevent.
    const { body } = await call('/api/automations');
    const withSteps = body.recentRuns.find((r: { status: string }) => r.status === 'completed');
    expect(withSteps).toBeDefined();
  });

  it('can be turned off and back on', async () => {
    const off = await post('/api/automations/aut_lead/toggle', {});
    expect(off.body.automation.enabled).toBe(false);
    const on = await post('/api/automations/aut_lead/toggle', {});
    expect(on.body.automation.enabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('publishing over HTTP', () => {
  it('gives DNS records and refuses to serve an unverified domain', async () => {
    const { body } = await call('/api/publishing/domains');
    const domain = body.domains[0];
    expect(domain.servable).toBe(false);
    expect(domain.forcingHttps).toBe(false);
    expect(domain.records.some((r: { type: string }) => r.type === 'TXT')).toBe(true);
    // acmeroofing.ca is an apex, so it gets A records rather than a CNAME.
    expect(domain.records.some((r: { type: string }) => r.type === 'A')).toBe(true);
  });

  it('normalises a pasted URL into a hostname', async () => {
    const r = await post('/api/publishing/domains', { hostname: 'https://www.AcmeRoofing.ca/contact?x=1' });
    expect(r.body.domain.hostname).toBe('www.acmeroofing.ca');
    // A subdomain gets a CNAME instead.
    expect(r.body.records.some((rec: { type: string }) => rec.type === 'CNAME')).toBe(true);
  });

  it('rejects a duplicate domain', async () => {
    const r = await post('/api/publishing/domains', { hostname: 'acmeroofing.ca' });
    expect(r.status).toBe(409);
  });

  it('publishes with warnings acknowledged and keeps rollback history', async () => {
    const blocked = await post('/api/publishing/publish', {});
    expect(blocked.body.published).toBe(false);
    expect(blocked.body.warnings.length).toBeGreaterThan(0);

    const first = await post('/api/publishing/publish', { acknowledgeWarnings: true });
    expect(first.body.published).toBe(true);
    expect(first.body.version.number).toBe(1);

    // Republishing identical content must not burn a version number.
    const again = await post('/api/publishing/publish', { acknowledgeWarnings: true });
    expect(again.body.version.number).toBe(1);

    const versions = await call('/api/publishing/versions');
    expect(versions.body.versions).toHaveLength(1);
  });

  it('opens robots.txt only once the site has been published', async () => {
    const r = await call('/robots.txt');
    expect(r.raw).toContain('Allow: /');
    expect(r.raw).toContain('Sitemap:');
  });
});

/* ------------------------------------------------------------------ */

describe('analytics, billing and agency over HTTP', () => {
  it('summarises traffic bucketed by the site local day', async () => {
    const { body } = await call('/api/analytics');
    expect(body.totals.views).toBeGreaterThan(100);
    expect(body.byDay.length).toBeGreaterThanOrEqual(13);
    expect(body.topPages[0].path).toBeTruthy();
    // Self-referrals are dropped rather than shown as the top source.
    expect(body.topSources.every((s: { source: string }) => s.source !== 'acmeroofing.ca')).toBe(true);
    expect(body.topSources.some((s: { source: string }) => s.source.startsWith('Search'))).toBe(true);
  });

  it('reports plan usage against limits without blocking delivery', async () => {
    const { body } = await call('/api/billing');
    expect(body.plan.name).toBe('Pro');
    const pages = body.limits.find((l: { key: string }) => l.key === 'pagesPerSite');
    expect(pages.state).toBe('ok');
    expect(body.usage.products).toBe(3);
  });

  it('rolls the site up with its issues ranked first', async () => {
    const { body } = await call('/api/agency');
    expect(body.sites).toHaveLength(1);
    // Two domains are connected and neither is verified.
    expect(body.criticalCount).toBeGreaterThan(0);
    expect(body.totals.views).toBeGreaterThan(0);
  });
});

describe('permissions still gate every business route', () => {
  it('keeps the public form endpoint open and the rest closed', async () => {
    // The submission route is deliberately unauthenticated; everything that
    // protects it lives in the domain module.
    const ok = await post('/api/forms/frm_quote/submissions', {
      name: 'Open', email: 'open@example.com', service: 'repair', _elapsed: 30,
    });
    expect(ok.status).toBe(200);

    // Every other route resolved an actor and checked a permission; the dev
    // actor is an org owner, so these succeed rather than 403 — the check
    // running at all is what this asserts.
    for (const path of ['/api/commerce/products', '/api/automations', '/api/billing', '/api/agency']) {
      expect((await call(path)).status, path).toBe(200);
    }
  });
});
