'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rates = require('../config/rates.sample.json');
const { quote, bestRate, ratesConfigured } = require('../lib/pricing');

const stay = (over = {}) => ({
  siteTypeId: 'full-service',
  arrival: '2026-07-10',
  departure: '2026-07-13',
  guests: 2,
  ...over,
});

test('prices a short stay at the nightly rate with HST on top', () => {
  const q = quote(rates, stay());
  assert.equal(q.nights, 3);
  assert.equal(q.basis, 'nightly');
  assert.equal(q.subtotal, 15600); // 3 × $52
  assert.equal(q.tax, 2340); // 15%
  assert.equal(q.total, 17940);
});

test('a week is billed weekly, not as seven nights', () => {
  const q = quote(rates, stay({ departure: '2026-07-17' }));
  assert.equal(q.nights, 7);
  assert.equal(q.basis, 'weekly');
  assert.equal(q.subtotal, 31200); // $312, cheaper than 7 × $52 = $364
});

test('an awkward stay picks weeks plus leftover nights', () => {
  const q = quote(rates, stay({ departure: '2026-07-19' })); // 9 nights
  assert.equal(q.basis, 'weekly');
  assert.equal(q.subtotal, 31200 + 2 * 5200);
});

test('a long stay is billed monthly then weekly then nightly', () => {
  const r = bestRate(rates.siteTypes[0], 38); // 1 month + 1 week + 3 nights
  assert.equal(r.basis, 'monthly');
  assert.equal(r.amount, 115000 + 31200 + 3 * 5200);
});

test('the guest is never charged more than the plain nightly rate', () => {
  for (let n = 1; n <= 60; n++) {
    const best = bestRate(rates.siteTypes[0], n);
    assert.ok(best.amount <= 5200 * n, `${n} nights priced above nightly`);
  }
});

test('extra guests are charged per night, only beyond the included count', () => {
  const four = quote(rates, stay({ guests: 4 }));
  const six = quote(rates, stay({ guests: 6 }));
  assert.equal(four.subtotal, 15600);
  assert.equal(six.subtotal, 15600 + 2 * 500 * 3);
});

test('the deposit is the first night plus its tax, and the balance is the rest', () => {
  const q = quote(rates, stay());
  assert.equal(q.deposit, 5200 + 780);
  assert.equal(q.deposit + q.balance, q.total);
});

test('a one-night stay never asks for a deposit larger than the total', () => {
  const q = quote(rates, stay({ departure: '2026-07-11' }));
  assert.equal(q.deposit, q.total);
  assert.equal(q.balance, 0);
});

test('deposit modes: full and percent', () => {
  const full = quote({ ...rates, deposit: { mode: 'full' } }, stay());
  assert.equal(full.deposit, full.total);

  const half = quote({ ...rates, deposit: { mode: 'percent', percent: 0.5 } }, stay());
  assert.equal(half.deposit, Math.round(half.total * 0.5));
});

test('a site type with no rate set refuses to sell rather than guessing', () => {
  const unpriced = require('../config/rates.json');
  assert.equal(ratesConfigured(unpriced), false);
  assert.throws(() => quote(unpriced, stay()), /No rate is set/);
});

test('unknown site types are rejected', () => {
  assert.throws(() => quote(rates, stay({ siteTypeId: 'yurt' })), /Unknown site type/);
});

test('line items always add up to the subtotal', () => {
  const q = quote(rates, stay({ departure: '2026-08-09', guests: 7 })); // 30 nights, extra guests
  assert.equal(q.lines.reduce((sum, l) => sum + l.amount, 0), q.subtotal);
});
