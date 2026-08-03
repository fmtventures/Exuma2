'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const flatRates = require('../config/rates.sample.json');
const realRates = require('../config/rates.json');
const { quote, seasonOf, fromRate, isPriced, ratesConfigured } = require('../lib/pricing');

/**
 * Two rate cards are exercised here: the sample one, where a price is a single
 * number all year, and the campground's real one, where each site type has a
 * high-season and a low-season price. Both have to work, because a campground
 * may start simple and add seasons later.
 */

const stay = (over = {}) => ({
  siteTypeId: 'full-service',
  arrival: '2026-07-10',
  departure: '2026-07-13',
  guests: 2,
  ...over,
});

/* ---------------- flat rates ---------------- */

test('prices a short stay at the nightly rate with HST on top', () => {
  const q = quote(flatRates, stay());
  assert.equal(q.nights, 3);
  assert.equal(q.subtotal, 15600); // 3 × $52
  assert.equal(q.tax, 2340); // 15%
  assert.equal(q.total, 17940);
  assert.match(q.lines[0].label, /3 nights at the nightly rate/);
});

test('a week is billed weekly, not as seven nights', () => {
  const q = quote(flatRates, stay({ departure: '2026-07-17' }));
  assert.equal(q.nights, 7);
  assert.equal(q.subtotal, 31200); // $312 beats 7 × $52
  assert.match(q.lines[0].label, /1 week at the weekly rate/);
});

test('an awkward stay picks weeks plus leftover nights', () => {
  const q = quote(flatRates, stay({ departure: '2026-07-19' })); // 9 nights
  assert.equal(q.subtotal, 31200 + 2 * 5200);
  assert.equal(q.lines.length, 2);
});

test('a long stay is billed monthly, then weekly, then nightly', () => {
  const q = quote(flatRates, stay({ departure: '2026-08-17' })); // 38 nights
  assert.equal(q.subtotal, 115000 + 31200 + 3 * 5200);
  assert.match(q.lines[0].label, /1 month/);
  assert.match(q.lines[1].label, /1 week/);
  assert.match(q.lines[2].label, /3 nights/);
});

test('the guest is never charged more than the plain nightly rate', () => {
  for (let n = 1; n <= 45; n++) {
    const departure = new Date(Date.UTC(2026, 6, 10 + n)).toISOString().slice(0, 10);
    const q = quote(flatRates, stay({ departure }));
    assert.ok(q.subtotal <= 5200 * n, `${n} nights priced above nightly`);
  }
});

test('extra guests are charged per night, only beyond the included count', () => {
  assert.equal(quote(flatRates, stay({ guests: 4 })).subtotal, 15600);
  assert.equal(quote(flatRates, stay({ guests: 6 })).subtotal, 15600 + 2 * 500 * 3);
});

test('line items always add up to the subtotal', () => {
  const q = quote(flatRates, stay({ departure: '2026-08-09', guests: 7 }));
  assert.equal(q.lines.reduce((sum, l) => sum + l.amount, 0), q.subtotal);
});

test('unknown site types are rejected', () => {
  assert.throws(() => quote(flatRates, stay({ siteTypeId: 'yurt' })), /Unknown site type/);
});

/* ---------------- seasonal rates ---------------- */

const summer = (over = {}) => ({
  siteTypeId: 'full-service-50',
  arrival: '2026-07-10',
  departure: '2026-07-13',
  guests: 2,
  ...over,
});

test('July is high season, May and late September are not', () => {
  assert.equal(seasonOf(realRates, '2026-07-10'), 'high');
  assert.equal(seasonOf(realRates, '2026-06-23'), 'high', 'the first day of the high band');
  assert.equal(seasonOf(realRates, '2026-06-22'), 'low', 'and the day before it is not');
  assert.equal(seasonOf(realRates, '2026-09-08'), 'low');
  assert.equal(seasonOf(realRates, '2026-12-25'), null, 'the campground is shut');
});

test('a summer stay on a 50 amp site uses the high-season rate', () => {
  const q = quote(realRates, summer());
  assert.equal(q.subtotal, 3 * 6300);
  assert.equal(q.total, 3 * 6300 + Math.round(3 * 6300 * 0.15));
  assert.deepEqual(q.seasons, ['high']);
  assert.match(q.lines[0].label, /high season/);
});

test('the same site in the shoulder season is cheaper', () => {
  const q = quote(realRates, summer({ arrival: '2026-05-10', departure: '2026-05-13' }));
  assert.equal(q.subtotal, 3 * 5400);
  assert.deepEqual(q.seasons, ['low']);
  assert.match(q.lines[0].label, /low season/);
});

test('a stay that crosses the season line is charged each part at its own rate', () => {
  // Two low-season nights, then two high-season ones.
  const q = quote(realRates, summer({ arrival: '2026-06-21', departure: '2026-06-25' }));
  assert.deepEqual(q.seasons, ['low', 'high']);
  assert.equal(q.lines.length, 2);
  assert.equal(q.subtotal, 2 * 5400 + 2 * 6300);
  assert.equal(q.lines.reduce((sum, l) => sum + l.amount, 0), q.subtotal);
});

test('a full week in one season gets that season\'s weekly rate', () => {
  const q = quote(realRates, summer({ arrival: '2026-07-01', departure: '2026-07-08' }));
  assert.equal(q.subtotal, 38500); // $385 beats 7 × $63
  assert.match(q.lines[0].label, /1 week at the weekly rate \(high season\)/);
});

test('a week straddling the season line is billed by the night, not smeared', () => {
  const q = quote(realRates, summer({ arrival: '2026-06-20', departure: '2026-06-27' }));
  assert.equal(q.subtotal, 3 * 5400 + 4 * 6300, 'three low nights and four high ones');
});

test('a season with no published rate is refused, with a reason', () => {
  // 30 amp has a high-season price but no low-season one entered yet.
  assert.equal(quote(realRates, { ...summer(), siteTypeId: 'full-service-30' }).subtotal, 3 * 4300);

  assert.throws(
    () => quote(realRates, { siteTypeId: 'full-service-30', arrival: '2026-05-10', departure: '2026-05-12', guests: 2 }),
    (err) => err.code === 'rates_unconfigured' && /low season rate/.test(err.message) && /call the campground/.test(err.message)
  );
});

test('a site type with no rate at all cannot be sold, but does not shut the campground', () => {
  const waterOnly = realRates.siteTypes.find((t) => t.id === 'water-only');
  assert.equal(isPriced(realRates, waterOnly), false);
  assert.equal(fromRate(realRates, waterOnly), null);
  assert.equal(ratesConfigured(realRates), true, 'the priced types are still open for business');

  assert.throws(
    () => quote(realRates, { siteTypeId: 'water-only', arrival: '2026-07-10', departure: '2026-07-12', guests: 2 }),
    (err) => err.code === 'rates_unconfigured'
  );
});

test('"from" is the cheapest published nightly rate for a type', () => {
  assert.equal(fromRate(realRates, realRates.siteTypes.find((t) => t.id === 'full-service-50')), 54);
  assert.equal(fromRate(realRates, realRates.siteTypes.find((t) => t.id === 'tent')), 33);
});

/* ---------------- deposits ---------------- */

test('the deposit is one night or a tenth of the bill, whichever is greater', () => {
  const short = quote(realRates, summer()); // 3 nights, one night is well over 10%
  assert.equal(short.deposit, 6300 + Math.round(6300 * 0.15));
  assert.equal(short.deposit + short.balance, short.total);

  const long = quote(realRates, summer({ arrival: '2026-07-01', departure: '2026-07-25' })); // 24 nights
  assert.equal(long.deposit, Math.round(long.total * 0.1), 'on a long stay the share is larger');
  assert.ok(long.deposit > 6300 + Math.round(6300 * 0.15));
});

test('a one-night stay never asks for a deposit larger than the total', () => {
  const q = quote(realRates, summer({ departure: '2026-07-11' }));
  assert.equal(q.deposit, q.total);
  assert.equal(q.balance, 0);
});

test('deposit modes: full and percent still work', () => {
  const full = quote({ ...realRates, deposit: { mode: 'full' } }, summer());
  assert.equal(full.deposit, full.total);

  const half = quote({ ...realRates, deposit: { mode: 'percent', percent: 0.5 } }, summer());
  assert.equal(half.deposit, Math.round(half.total * 0.5));
});
