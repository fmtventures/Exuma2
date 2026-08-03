'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../lib/app');
const { MemoryCalendarStore, parseBlock, eventToRecords } = require('../lib/calendar');
const { computeSiteOccupancy, freeSitesForStay } = require('../lib/availability');
const { addDays, today } = require('../lib/dates');
const sitemap = require('../lib/sitemap');
const sampleRates = require('../config/rates.sample.json');

/**
 * Picking a numbered site off the map. The rules that matter: the map decides
 * how many sites exist, a square can only be sold once, and what the office
 * blocks by hand disappears from the map.
 */

const day = (n) => addDays(today(), n);

// A small campground, so the assertions can be counted on fingers.
const SITE_MAP = {
  bounds: { width: 100, height: 100 },
  sites: [
    { number: '1', typeId: 'full-service', amps: 50, hookups: ['power', 'water', 'sewer'], pullThrough: true, x: 10, y: 20, features: ['Pull-through'] },
    { number: '2', typeId: 'full-service', amps: 30, hookups: ['power', 'water', 'sewer'], x: 20, y: 20, features: [] },
    { number: '3', typeId: 'full-service', amps: 30, hookups: ['power', 'water', 'sewer'], x: 30, y: 20, features: [] },
    { number: '10', typeId: 'power-water', amps: 15, hookups: ['power', 'water'], x: 10, y: 50, features: [] },
    { number: '11', typeId: 'power-water', amps: 30, hookups: ['power', 'water'], x: 20, y: 50, features: [] },
    { number: '20', typeId: 'tent', amps: null, hookups: [], x: 10, y: 80, features: ['Shaded'] },
  ],
};

const rates = sitemap.reconcile(SITE_MAP, { ...sampleRates, season: null }, () => {});

function stubPayments() {
  const sessions = [];
  return {
    sessions,
    async createCheckout({ quote, ref }) {
      const session = { id: `cs_${sessions.length + 1}`, url: 'https://stripe.test/x', amount_total: quote.deposit, ref };
      sessions.push(session);
      return session;
    },
    parseWebhook(raw) { return JSON.parse(raw.toString('utf8')); },
    async refund() { return { id: 're_1' }; },
  };
}

async function harness(t) {
  const store = new MemoryCalendarStore();
  const app = createApp({
    rates,
    store,
    payments: stubPayments(),
    mailer: { async send() {} },
    secret: 'test-secret',
    siteMap: SITE_MAP,
    publicUrl: 'https://example.test',
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
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
    booking: (over = {}) => ({
      arrival: day(10), departure: day(13), guests: 2,
      name: 'Jane Arsenault', email: 'jane@example.com', ...over,
    }),
  };
}

test('the map decides how many sites of each type exist', () => {
  const counts = sitemap.inventory(SITE_MAP);
  assert.deepEqual(counts, { 'full-service': 3, 'power-water': 2, tent: 1 });

  const warnings = [];
  const merged = sitemap.reconcile(SITE_MAP, sampleRates, (m) => warnings.push(m));
  assert.equal(merged.siteTypes.find((t) => t.id === 'full-service').inventory, 3);
  assert.ok(warnings.length, 'a rate card that disagrees with the map is worth saying out loud');
});

test('a broken map is refused rather than half-loaded', () => {
  const bad = (sites) => () => sitemap.validate({ sites }, sampleRates);
  assert.throws(bad([{ number: '1', typeId: 'full-service', x: 1, y: 1 }, { number: '1', typeId: 'tent', x: 2, y: 2 }]), /appears twice/);
  assert.throws(bad([{ number: '1', typeId: 'treehouse', x: 1, y: 1 }]), /unknown type/);
  assert.throws(bad([{ number: '1', typeId: 'tent' }]), /no position/);
  assert.throws(bad([{ number: '1', typeId: 'tent', amps: 240, x: 1, y: 1 }]), /odd power rating/);
});

test('service levels read the way a camper would say them', () => {
  assert.equal(sitemap.serviceLabel(SITE_MAP.sites[0]), 'Full service · 50 amp');
  assert.equal(sitemap.serviceLabel(SITE_MAP.sites[4]), 'Power & water · 30 amp');
  assert.equal(sitemap.serviceLabel(SITE_MAP.sites[5]), 'Unserviced');
});

test('the office can close one square from a phone: "BLOCK 11"', () => {
  const index = sitemap.index(SITE_MAP);
  assert.deepEqual(parseBlock('BLOCK 11', rates.siteTypes, index), [
    { siteTypeId: 'power-water', siteNumber: '11', units: 1 },
  ]);
  assert.equal(parseBlock('BLOCK 1, 2', rates.siteTypes, index).length, 2);

  // A type block still means "any two of these", not sites 2 and nothing else.
  const typeBlock = parseBlock('BLOCK tent x2', rates.siteTypes, index);
  assert.deepEqual(typeBlock, [{ siteTypeId: 'tent', units: 2 }]);

  assert.equal(parseBlock('BLOCK 99', rates.siteTypes, index), null, 'a site we do not have is not a block');
  assert.equal(parseBlock('Dentist at 11', rates.siteTypes, index), null);
});

test('occupancy is tracked per square, and races show up as two claims', () => {
  const occupancy = [
    { siteTypeId: 'full-service', siteNumber: '2', arrival: day(10), departure: day(12), state: 'confirmed' },
    { siteTypeId: 'full-service', siteNumber: '2', arrival: day(10), departure: day(11), state: 'hold', holdExpires: new Date(Date.now() + 6e5).toISOString() },
    { siteTypeId: 'tent', arrival: day(10), departure: day(11), state: 'block', units: 1 },
  ];
  const grid = computeSiteOccupancy(occupancy, day(10), day(12));

  assert.deepEqual(grid[day(10)].taken, ['2']);
  assert.equal(grid[day(10)].claims['2'], 2, 'two records want the same square');
  assert.deepEqual(grid[day(10)].typeHolds, { tent: 1 });
  assert.deepEqual(grid[day(12)].taken, [], 'departure day is free again');
});

test('free sites exclude the taken ones and respect type-level blocks', () => {
  const occupancy = [
    { siteTypeId: 'full-service', siteNumber: '1', arrival: day(10), departure: day(13), state: 'confirmed' },
    { siteTypeId: 'full-service', arrival: day(10), departure: day(13), state: 'block', units: 1 },
  ];
  const grid = computeSiteOccupancy(occupancy, day(10), day(13));
  const free = freeSitesForStay(SITE_MAP.sites, grid, 'full-service', day(10), day(13));

  assert.equal(free.length, 1, 'one sold, one blocked by type, one left');
  assert.equal(free[0].number, '2', 'and it is offered lowest number first');
});

test('the website can fetch the map with prices and service levels attached', async (t) => {
  const h = await harness(t);
  const { status, body } = await h.get('/api/sites');

  assert.equal(status, 200);
  assert.equal(body.sites.length, 6);
  const site = body.sites.find((s) => s.number === '1');
  assert.equal(site.typeName, 'Full service');
  assert.equal(site.amps, 50);
  assert.equal(site.nightly, 52);
  assert.equal((await h.get('/api/config')).body.hasSiteMap, true);
});

test('availability says which squares are taken, night by night', async (t) => {
  const h = await harness(t);
  await h.post('/api/checkout', h.booking({ siteNumber: '2' }));

  const { body } = await h.get(`/api/availability?from=${day(10)}&to=${day(13)}`);
  assert.deepEqual(body.sites[day(10)].taken, ['2']);
  assert.deepEqual(body.sites[day(13)].taken, []);
  assert.equal(body.grid[day(10)]['full-service'], 2);
});

test('booking a square off the map holds that exact site', async (t) => {
  const h = await harness(t);
  const { status, body } = await h.post('/api/checkout', h.booking({ siteNumber: '3' }));

  assert.equal(status, 200);
  const [event] = await h.store.listEvents();
  assert.equal(event.extendedProperties.private.siteNumber, '3');
  assert.equal(event.extendedProperties.private.siteTypeId, 'full-service', 'the type follows from the site');
  assert.match(event.summary, /^HOLD · Site 3 · Jane Arsenault$/);
  assert.match(event.description, /^Site 3 · Full service —/);
  assert.ok(body.ref);
});

test('the same square cannot be sold to two people', async (t) => {
  const h = await harness(t);
  await h.post('/api/checkout', h.booking({ siteNumber: '1' }));

  const second = await h.post('/api/checkout', h.booking({ siteNumber: '1', name: 'Marc Doucette', email: 'marc@example.com' }));
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'site_taken');
  assert.match(second.body.error, /Site 1 is taken/);
  assert.equal((await h.store.listEvents()).length, 1);
});

test('overlapping nights collide; touching nights do not', async (t) => {
  const h = await harness(t);
  await h.post('/api/checkout', h.booking({ siteNumber: '1', arrival: day(10), departure: day(12) }));

  const overlap = await h.post('/api/checkout', h.booking({ siteNumber: '1', arrival: day(11), departure: day(14) }));
  assert.equal(overlap.status, 409);

  const changeover = await h.post('/api/checkout', h.booking({ siteNumber: '1', arrival: day(12), departure: day(14) }));
  assert.equal(changeover.status, 200, 'the next guest can arrive the day the last one leaves');
});

test('a guest who picks only a type still gets a specific site', async (t) => {
  const h = await harness(t);
  await h.post('/api/checkout', h.booking({ siteNumber: '1' }));

  const { status } = await h.post('/api/checkout', h.booking({ siteTypeId: 'full-service', name: 'Marc Doucette', email: 'marc@example.com' }));
  assert.equal(status, 200);

  const events = await h.store.listEvents();
  const assigned = events.map((e) => e.extendedProperties.private.siteNumber).sort();
  assert.deepEqual(assigned, ['1', '2'], 'the next free square, not a vague promise');
});

test('a site the office blocked by hand is not sold', async (t) => {
  const h = await harness(t);
  h.store.put({
    summary: 'BLOCK 2 — septic work',
    start: { date: day(9) },
    end: { date: day(15) },
    extendedProperties: { private: {} },
  });

  const blocked = await h.post('/api/checkout', h.booking({ siteNumber: '2' }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'site_taken');

  const avail = await h.get(`/api/availability?from=${day(10)}&to=${day(12)}`);
  assert.ok(avail.body.sites[day(10)].taken.includes('2'));
});

test('a site number we do not have is refused before anything is held', async (t) => {
  const h = await harness(t);
  const { status, body } = await h.post('/api/checkout', h.booking({ siteNumber: '404' }));

  assert.equal(status, 400);
  assert.equal(body.code, 'unknown_site');
  assert.equal((await h.store.listEvents()).length, 0);
});

test('an expired hold frees its square again', async (t) => {
  const h = await harness(t);
  const lapsed = {
    summary: 'HOLD · Site 1 · Someone',
    start: { date: day(10) },
    end: { date: day(13) },
    extendedProperties: {
      private: {
        app: 'ape', state: 'hold', siteTypeId: 'full-service', siteNumber: '1',
        holdExpires: new Date(Date.now() - 60000).toISOString(),
      },
    },
  };
  h.store.put(lapsed);

  const { status } = await h.post('/api/checkout', h.booking({ siteNumber: '1' }));
  assert.equal(status, 200, 'an abandoned checkout does not keep a square off the market');
});

test('cancelling puts that square back on the map', async (t) => {
  const h = await harness(t);
  const tokens = require('../lib/tokens');
  const booked = await h.post('/api/checkout', h.booking({ siteNumber: '1' }));
  const session = (await h.store.listEvents())[0];
  await h.post('/api/stripe/webhook', {
    type: 'checkout.session.completed',
    data: { object: { id: session.extendedProperties.private.sessionId, payment_intent: 'pi_1', amount_total: 5980 } },
  });

  await h.post('/api/cancel', { ref: booked.body.ref, token: tokens.sign(booked.body.ref, 'test-secret') });

  const avail = await h.get(`/api/availability?from=${day(10)}&to=${day(12)}`);
  assert.deepEqual(avail.body.sites[day(10)].taken, []);
  const retry = await h.post('/api/checkout', h.booking({ siteNumber: '1', name: 'Marc Doucette', email: 'marc@example.com' }));
  assert.equal(retry.status, 200);
});

test('timed calendar events never take a site off the map', () => {
  const index = sitemap.index(SITE_MAP);
  const meeting = {
    id: 'x',
    summary: 'BLOCK 1',
    start: { dateTime: '2026-07-10T09:00:00Z' },
    end: { dateTime: '2026-07-10T10:00:00Z' },
  };
  assert.deepEqual(eventToRecords(meeting, rates.siteTypes, index), []);
});
