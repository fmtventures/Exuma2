'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../lib/app');
const { MemoryCalendarStore } = require('../lib/calendar');
const { addDays, today } = require('../lib/dates');
const sampleRates = require('../config/rates.sample.json');

/**
 * End to end over HTTP, with the calendar in memory and Stripe stubbed. These
 * are the paths where money and inventory meet, so they are exercised as the
 * browser would: request a quote, hold a site, pay, get confirmed.
 */

// Season limits are tested separately; here they would make the suite depend on
// the day it runs.
const rates = { ...sampleRates, season: null };
const day = (n) => addDays(today(), n);

function stubPayments() {
  const sessions = [];
  return {
    sessions,
    async createCheckout({ quote, ref, eventId }) {
      const session = {
        id: `cs_test_${sessions.length + 1}`,
        url: `https://checkout.stripe.test/${ref}`,
        amount_total: quote.deposit,
        payment_intent: `pi_test_${sessions.length + 1}`,
        metadata: { ref, eventId },
      };
      sessions.push(session);
      return session;
    },
    parseWebhook(raw) {
      return JSON.parse(raw.toString('utf8'));
    },
  };
}

async function harness({ rates: r = rates, payments = stubPayments(), inventory } = {}) {
  const used = inventory
    ? { ...r, siteTypes: r.siteTypes.map((t) => ({ ...t, inventory: inventory[t.id] ?? t.inventory })) }
    : r;
  const store = new MemoryCalendarStore();
  const app = createApp({ rates: used, store, payments, publicUrl: 'https://example.test' });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    store,
    payments,
    base,
    async get(path) {
      const res = await fetch(base + path);
      return { status: res.status, body: await res.json() };
    },
    async post(path, body, headers = {}) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { error: text }; // rejected webhooks answer in plain text, as Stripe expects
        }
      }
      return { status: res.status, body: parsed };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const booking = (over = {}) => ({
  siteTypeId: 'full-service',
  arrival: day(10),
  departure: day(13),
  guests: 2,
  name: 'Jane Arsenault',
  email: 'jane@example.com',
  phone: '902-555-0134',
  ...over,
});

test('the site fetches its rate card and knows booking is open', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { status, body } = await h.get('/api/config');
  assert.equal(status, 200);
  assert.equal(body.bookingOpen, true);
  assert.equal(body.siteTypes.length, 3);
  assert.equal(body.taxLabel, 'HST');
  assert.ok(body.holdMinutes >= 30, 'the hold must outlast a Stripe session');
});

test('availability comes back as a night-by-night grid', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { body } = await h.get(`/api/availability?from=${day(0)}&to=${day(5)}`);
  assert.equal(body.grid[day(3)]['full-service'], 20);
});

test('an over-long availability window is capped, not refused', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { status, body } = await h.get(`/api/availability?from=${day(0)}&to=${day(900)}`);
  assert.equal(status, 200);
  assert.equal(body.to, day(120));
});

test('a quote is returned without holding anything', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { status, body } = await h.post('/api/quote', booking());
  assert.equal(status, 200);
  assert.equal(body.quote.nights, 3);
  assert.equal(body.quote.total, 17940);
  assert.equal((await h.store.listEvents()).length, 0, 'quoting must not touch the calendar');
});

test('bad input is refused with a message a guest can act on', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const cases = [
    [booking({ departure: day(10) }), 'bad_range'],
    [booking({ arrival: day(-3), departure: day(-1) }), 'past_date'],
    [booking({ guests: 99 }), 'bad_guests'],
    [booking({ arrival: 'soon', departure: day(12) }), 'bad_date'],
    [booking({ siteTypeId: 'treehouse' }), 'unknown_site_type'],
    [booking({ departure: day(60) }), 'above_max_nights'],
  ];

  for (const [payload, code] of cases) {
    const { status, body } = await h.post('/api/quote', payload);
    assert.equal(body.code, code, `expected ${code}, got ${body.code}`);
    assert.ok(status >= 400 && status < 500);
    assert.ok(body.error.length > 0);
  }
});

test('a stay can be priced before anyone has typed their name', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const { siteTypeId, arrival, departure, guests } = booking();
  const { status, body } = await h.post('/api/quote', { siteTypeId, arrival, departure, guests });
  assert.equal(status, 200);
  assert.equal(body.quote.total, 17940);
});

test('contact details are still required to hold a site', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  for (const [payload, code] of [
    [booking({ email: 'not-an-email' }), 'bad_email'],
    [booking({ name: '' }), 'bad_name'],
  ]) {
    const { status, body } = await h.post('/api/checkout', payload);
    assert.equal(body.code, code);
    assert.equal(status, 400);
  }
  assert.equal((await h.store.listEvents()).length, 0, 'a refused checkout must not hold a site');
});

test('checkout holds the site, hands back a Stripe URL, and the hold shows in availability', async (t) => {
  const h = await harness({ inventory: { 'full-service': 1 } });
  t.after(() => h.close());

  const { status, body } = await h.post('/api/checkout', booking());
  assert.equal(status, 200);
  assert.match(body.url, /checkout\.stripe\.test/);
  assert.match(body.ref, /^APE-[A-Z0-9]{5}$/);

  const events = await h.store.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].extendedProperties.private.state, 'hold');
  assert.equal(events[0].status, 'tentative');
  assert.equal(events[0].end.date, day(13), 'departure is the exclusive end of an all-day event');

  const { body: avail } = await h.get(`/api/availability?from=${day(10)}&to=${day(13)}`);
  assert.equal(avail.grid[day(10)]['full-service'], 0);
  assert.equal(avail.grid[day(13)]['full-service'], 1, 'the departure day is free again');
});

test('the last site cannot be sold twice', async (t) => {
  const h = await harness({ inventory: { 'full-service': 1 } });
  t.after(() => h.close());

  const first = await h.post('/api/checkout', booking());
  assert.equal(first.status, 200);

  const second = await h.post('/api/checkout', booking({ name: 'Marc Doucette', email: 'marc@example.com' }));
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'unavailable');
  assert.equal((await h.store.listEvents()).length, 1, 'the refused attempt must not leave a hold behind');
});

test('paying confirms the hold into a booking on the calendar', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  await h.post('/api/checkout', booking());
  const session = h.payments.sessions[0];

  const hook = await h.post('/api/stripe/webhook', {
    type: 'checkout.session.completed',
    data: { object: { id: session.id, payment_intent: 'pi_test_1', amount_total: session.amount_total } },
  });
  assert.equal(hook.status, 200);

  const [event] = await h.store.listEvents();
  const props = event.extendedProperties.private;
  assert.equal(props.state, 'confirmed');
  assert.equal(event.status, 'confirmed');
  assert.match(event.summary, /^Booked · Full service · Jane Arsenault$/);
  assert.equal(props.paymentRef, 'pi_test_1');
  assert.match(event.description, /Balance on arrival/);
  assert.match(event.description, /jane@example\.com/);
});

test('a webhook delivered twice does not double-book or double-record', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  await h.post('/api/checkout', booking());
  const session = h.payments.sessions[0];
  const payload = {
    type: 'checkout.session.completed',
    data: { object: { id: session.id, payment_intent: 'pi_test_1', amount_total: session.amount_total } },
  };

  await h.post('/api/stripe/webhook', payload);
  await h.post('/api/stripe/webhook', payload);

  const events = await h.store.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].description.match(/Payment:/g).length, 1);
});

test('an abandoned checkout releases the site when Stripe expires the session', async (t) => {
  const h = await harness({ inventory: { tent: 1 } });
  t.after(() => h.close());

  await h.post('/api/checkout', booking({ siteTypeId: 'tent' }));
  const session = h.payments.sessions[0];

  await h.post('/api/stripe/webhook', { type: 'checkout.session.expired', data: { object: { id: session.id } } });

  assert.equal((await h.store.listEvents()).length, 0);
  const { body } = await h.get(`/api/availability?from=${day(10)}&to=${day(10)}`);
  assert.equal(body.grid[day(10)].tent, 1);
});

test('an expiry webhook arriving after payment leaves the booking alone', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  await h.post('/api/checkout', booking());
  const session = h.payments.sessions[0];

  await h.post('/api/stripe/webhook', {
    type: 'checkout.session.completed',
    data: { object: { id: session.id, payment_intent: 'pi_1', amount_total: session.amount_total } },
  });
  await h.post('/api/stripe/webhook', { type: 'checkout.session.expired', data: { object: { id: session.id } } });

  const events = await h.store.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].extendedProperties.private.state, 'confirmed');
});

test('a forged webhook is rejected before it can confirm anything', async (t) => {
  const payments = stubPayments();
  payments.parseWebhook = () => {
    throw new Error('No signatures found matching the expected signature');
  };
  const h = await harness({ payments });
  t.after(() => h.close());

  const { status } = await h.post('/api/stripe/webhook', { type: 'checkout.session.completed', data: { object: {} } });
  assert.equal(status, 400);
});

test('if Stripe fails to open a session, the site is not left held', async (t) => {
  const payments = stubPayments();
  payments.createCheckout = async () => {
    throw new Error('Stripe is down');
  };
  const h = await harness({ payments });
  t.after(() => h.close());

  const { status } = await h.post('/api/checkout', booking());
  assert.equal(status, 500);
  assert.equal((await h.store.listEvents()).length, 0);
});

test('with no rates entered, the site says call us instead of selling', async (t) => {
  // A fresh rate card, before anybody has typed a price into it.
  const unpriced = {
    ...rates,
    siteTypes: rates.siteTypes.map((type) => ({ ...type, nightly: null, weekly: null, monthly: null })),
  };
  const h = await harness({ rates: unpriced });
  t.after(() => h.close());

  const config = await h.get('/api/config');
  assert.equal(config.body.bookingOpen, false);

  const { status, body } = await h.post('/api/checkout', booking());
  assert.equal(status, 503);
  assert.match(body.error, /call the campground/);
});

test('with Stripe unconfigured, availability still works but checkout is closed', async (t) => {
  const h = await harness({ payments: null });
  t.after(() => h.close());

  assert.equal((await h.get('/api/config')).body.bookingOpen, false);
  assert.equal((await h.get(`/api/availability?from=${day(0)}&to=${day(3)}`)).status, 200);
  assert.equal((await h.post('/api/checkout', booking())).status, 503);
});

test('a hold that lands into an oversold night is withdrawn, not sold', async (t) => {
  // Two guests reach checkout in the same instant: the availability check
  // passes for both, then the second hold discovers it lost the race.
  const store = new MemoryCalendarStore();
  const real = store.listOccupancy.bind(store);
  let firstLook = true;
  store.listOccupancy = async (...args) => {
    if (firstLook) {
      firstLook = false;
      return []; // the pre-check sees an empty calendar, as the loser would
    }
    return real(...args);
  };

  const single = { ...rates, siteTypes: rates.siteTypes.map((s) => ({ ...s, inventory: 1 })) };
  const rival = await store.createHold(
    { name: 'Rival', email: 'r@example.com', guests: 2, ref: 'APE-RIVAL', siteTypeName: 'Full service' },
    { siteTypeId: 'full-service', arrival: day(10), departure: day(13), nights: 3, total: 1, deposit: 1, balance: 0, taxLabel: 'HST', tax: 0 },
    new Date(Date.now() + 30 * 60000).toISOString()
  );

  const app = createApp({ rates: single, store, payments: stubPayments(), publicUrl: 'https://example.test' });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(booking()),
  });
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.code, 'unavailable');
  const events = await store.listEvents();
  assert.equal(events.length, 1, 'only the winning hold survives');
  assert.equal(events[0].id, rival.id);
});
