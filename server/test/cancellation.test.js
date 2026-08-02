'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../lib/app');
const { MemoryCalendarStore } = require('../lib/calendar');
const { addDays, today } = require('../lib/dates');
const tokens = require('../lib/tokens');
const sampleRates = require('../config/rates.sample.json');

/**
 * Confirmation email and guest cancellation. Both touch money or the guest's
 * inbox, so the rules that matter are: send once, refund once, and never let
 * one guest reach another guest's booking.
 */

const SECRET = 'test-secret-for-signing-links';
const rates = { ...sampleRates, season: null };
const day = (n) => addDays(today(), n);

function stubs() {
  const sent = [];
  const refunds = [];
  return {
    sent,
    refunds,
    mailer: { async send(message) { sent.push(message); return { ok: true }; } },
    payments: {
      sessions: [],
      async createCheckout({ quote, ref }) {
        const session = { id: `cs_${this.sessions.length + 1}`, url: 'https://stripe.test/x', amount_total: quote.deposit, ref };
        this.sessions.push(session);
        return session;
      },
      parseWebhook(raw) { return JSON.parse(raw.toString('utf8')); },
      async refund(paymentRef, amountCents, ref) {
        refunds.push({ paymentRef, amountCents, ref });
        return { id: 're_1' };
      },
    },
  };
}

async function harness(t, over = {}) {
  const s = stubs();
  const store = new MemoryCalendarStore();
  const app = createApp({
    rates: over.rates || rates,
    store,
    payments: s.payments,
    mailer: s.mailer,
    secret: SECRET,
    publicUrl: 'https://example.test',
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = {
    ...s,
    store,
    async get(path) {
      const res = await fetch(base + path);
      return { status: res.status, body: await res.json() };
    },
    async post(path, body) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    /** Book and pay, the way a guest would, and hand back the reference. */
    async book(over = {}) {
      const { body } = await api.post('/api/checkout', {
        siteTypeId: 'full-service',
        arrival: day(10),
        departure: day(13),
        guests: 2,
        name: 'Jane Arsenault',
        email: 'jane@example.com',
        phone: '902-555-0134',
        ...over,
      });
      const session = s.payments.sessions[s.payments.sessions.length - 1];
      await api.post('/api/stripe/webhook', {
        type: 'checkout.session.completed',
        data: { object: { id: session.id, payment_intent: 'pi_1', amount_total: session.amount_total } },
      });
      return { ref: body.ref, session };
    },
  };
  return api;
}

test('paying emails the guest and the office, once each', async (t) => {
  const h = await harness(t);
  const { ref } = await h.book();

  assert.equal(h.sent.length, 2);
  const guest = h.sent.find((m) => m.to === 'jane@example.com');
  const office = h.sent.find((m) => m.to !== 'jane@example.com');

  assert.match(guest.subject, new RegExp(ref));
  assert.match(guest.text, /Reference:\s+APE-/);
  assert.match(guest.text, /check-in from 14:00/);
  assert.match(guest.text, /515 North Lake Harbour Road/);
  assert.match(guest.text, /Due on arrival:\s+\$119\.60/);
  assert.match(office.subject, /New booking/);
  assert.match(office.text, /902-555-0134/);
});

test('a replayed webhook does not send a second confirmation', async (t) => {
  const h = await harness(t);
  await h.book();
  const session = h.payments.sessions[0];

  await h.post('/api/stripe/webhook', {
    type: 'checkout.session.completed',
    data: { object: { id: session.id, payment_intent: 'pi_1', amount_total: session.amount_total } },
  });

  assert.equal(h.sent.length, 2, 'still just the original pair');
});

test('the confirmation carries a cancellation link that works', async (t) => {
  const h = await harness(t);
  const { ref } = await h.book();

  const guest = h.sent.find((m) => m.to === 'jane@example.com');
  const link = guest.text.match(/https:\/\/example\.test\/\?cancel=[^\s]+/)[0];
  const url = new URL(link);

  assert.equal(url.searchParams.get('cancel'), ref);
  assert.equal(tokens.verify(ref, url.searchParams.get('t'), SECRET), true);

  const { status, body } = await h.get(`/api/booking?ref=${ref}&t=${url.searchParams.get('t')}`);
  assert.equal(status, 200);
  assert.equal(body.booking.state, 'confirmed');
  assert.equal(body.booking.siteTypeName, 'Full service');
  assert.equal(body.terms.canSelfCancel, true);
  assert.equal(body.terms.refundsDeposit, true);
});

test('a guessed reference gets nowhere without the signature', async (t) => {
  const h = await harness(t);
  const { ref } = await h.book();

  const forged = await h.get(`/api/booking?ref=${ref}&t=${'0'.repeat(32)}`);
  assert.equal(forged.status, 403);
  assert.equal(forged.body.code, 'bad_token');

  const cancel = await h.post('/api/cancel', { ref, token: 'x'.repeat(32) });
  assert.equal(cancel.status, 403);
  assert.equal(h.refunds.length, 0);

  const events = await h.store.listEvents();
  assert.equal(events[0].extendedProperties.private.state, 'confirmed', 'the booking is untouched');
});

test('an unknown reference is a plain not-found', async (t) => {
  const h = await harness(t);
  const ref = 'APE-NOPE1';
  const { status, body } = await h.get(`/api/booking?ref=${ref}&t=${tokens.sign(ref, SECRET)}`);
  assert.equal(status, 404);
  assert.equal(body.code, 'not_found');
});

test('cancelling well ahead refunds the deposit and puts the site back on sale', async (t) => {
  const h = await harness(t);
  const { ref } = await h.book();

  const before = await h.get(`/api/availability?from=${day(10)}&to=${day(10)}`);
  assert.equal(before.body.grid[day(10)]['full-service'], 19);

  const { status, body } = await h.post('/api/cancel', { ref, token: tokens.sign(ref, SECRET) });
  assert.equal(status, 200);
  assert.equal(body.refundCents, 5980);
  assert.deepEqual(h.refunds, [{ paymentRef: 'pi_1', amountCents: 5980, ref }]);

  const after = await h.get(`/api/availability?from=${day(10)}&to=${day(10)}`);
  assert.equal(after.body.grid[day(10)]['full-service'], 20, 'the site is free again');

  const [event] = await h.store.listEvents();
  assert.equal(event.extendedProperties.private.state, 'cancelled');
  assert.match(event.summary, /^CANCELLED · /, 'the record stays on the calendar');

  const note = h.sent.find((m) => /cancelled/i.test(m.subject) && m.to === 'jane@example.com');
  assert.match(note.text, /refund of \$59\.80/i);
});

test('cancelling inside the refund window still cancels, without a refund', async (t) => {
  const h = await harness(t);
  const { ref } = await h.book({ arrival: day(4), departure: day(6) });

  const { status, body } = await h.post('/api/cancel', { ref, token: tokens.sign(ref, SECRET) });
  assert.equal(status, 200);
  assert.equal(body.refundCents, 0);
  assert.equal(h.refunds.length, 0);

  const [event] = await h.store.listEvents();
  assert.equal(event.extendedProperties.private.state, 'cancelled');

  const note = h.sent.find((m) => /cancelled/i.test(m.subject) && m.to === 'jane@example.com');
  assert.match(note.text, /No refund was due/);
});

test('too close to arrival, the guest is sent to the phone and nothing changes', async (t) => {
  const h = await harness(t);
  const { ref } = await h.book({ arrival: day(1), departure: day(3) });

  const { status, body } = await h.post('/api/cancel', { ref, token: tokens.sign(ref, SECRET) });
  assert.equal(status, 409);
  assert.equal(body.code, 'too_late');
  assert.match(body.error, /call us/);

  const [event] = await h.store.listEvents();
  assert.equal(event.extendedProperties.private.state, 'confirmed');
  assert.equal(h.refunds.length, 0);
});

test('cancelling twice refunds once', async (t) => {
  const h = await harness(t);
  const { ref } = await h.book();
  const token = tokens.sign(ref, SECRET);

  const first = await h.post('/api/cancel', { ref, token });
  const second = await h.post('/api/cancel', { ref, token });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyCancelled, true);
  assert.equal(h.refunds.length, 1);
  assert.equal(h.sent.filter((m) => /cancelled/i.test(m.subject)).length, 2, 'one notice to the guest, one to the office');
});

test('a cancelled site can be booked by somebody else', async (t) => {
  const h = await harness(t, { rates: { ...rates, siteTypes: rates.siteTypes.map((s) => ({ ...s, inventory: 1 })) } });
  const { ref } = await h.book();

  const blocked = await h.post('/api/checkout', {
    siteTypeId: 'full-service', arrival: day(10), departure: day(13), guests: 2,
    name: 'Marc Doucette', email: 'marc@example.com',
  });
  assert.equal(blocked.status, 409);

  await h.post('/api/cancel', { ref, token: tokens.sign(ref, SECRET) });

  const retry = await h.post('/api/checkout', {
    siteTypeId: 'full-service', arrival: day(10), departure: day(13), guests: 2,
    name: 'Marc Doucette', email: 'marc@example.com',
  });
  assert.equal(retry.status, 200);
});

test('a mail server having a bad morning does not cost a paid booking', async (t) => {
  const h = await harness(t);
  h.mailer.send = async () => { throw new Error('SMTP connection refused'); };

  const { ref } = await h.book();
  const [event] = await h.store.listEvents();

  assert.ok(ref);
  assert.equal(event.extendedProperties.private.state, 'confirmed', 'the booking stands regardless');
});
