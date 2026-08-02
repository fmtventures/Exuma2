'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rates = require('../config/rates.sample.json');
const { computeAvailability, isStayAvailable, unavailableNights } = require('../lib/availability');
const { parseBlock, eventToRecords } = require('../lib/calendar');

const NOW = Date.parse('2026-07-01T12:00:00Z');
const tiny = {
  ...rates,
  siteTypes: [
    { ...rates.siteTypes[0], inventory: 2 },
    { ...rates.siteTypes[2], inventory: 1 },
  ],
};

test('an empty calendar leaves every site free', () => {
  const grid = computeAvailability(tiny, [], '2026-07-10', '2026-07-12', NOW);
  assert.equal(grid['2026-07-10']['full-service'], 2);
  assert.equal(grid['2026-07-11'].tent, 1);
});

test('a booking occupies its nights but frees the departure day', () => {
  const grid = computeAvailability(
    tiny,
    [{ siteTypeId: 'full-service', arrival: '2026-07-10', departure: '2026-07-12', state: 'confirmed' }],
    '2026-07-09',
    '2026-07-13',
    NOW
  );
  assert.equal(grid['2026-07-09']['full-service'], 2);
  assert.equal(grid['2026-07-10']['full-service'], 1);
  assert.equal(grid['2026-07-11']['full-service'], 1);
  assert.equal(grid['2026-07-12']['full-service'], 2, 'departure morning frees the site for the next guest');
});

test('back-to-back stays can share a changeover day', () => {
  const occupancy = [
    { siteTypeId: 'tent', arrival: '2026-07-10', departure: '2026-07-12', state: 'confirmed' },
    { siteTypeId: 'tent', arrival: '2026-07-12', departure: '2026-07-14', state: 'confirmed' },
  ];
  const grid = computeAvailability(tiny, occupancy, '2026-07-10', '2026-07-14', NOW);
  assert.equal(grid['2026-07-12'].tent, 0);
  assert.equal(grid['2026-07-13'].tent, 0);
  assert.equal(grid['2026-07-14'].tent, 1);
});

test('a live hold blocks the site; a lapsed one does not', () => {
  const record = (holdExpires) => [{
    siteTypeId: 'tent',
    arrival: '2026-07-10',
    departure: '2026-07-11',
    state: 'hold',
    holdExpires,
  }];

  const live = computeAvailability(tiny, record('2026-07-01T12:20:00Z'), '2026-07-10', '2026-07-10', NOW);
  assert.equal(live['2026-07-10'].tent, 0);

  const lapsed = computeAvailability(tiny, record('2026-07-01T11:40:00Z'), '2026-07-10', '2026-07-10', NOW);
  assert.equal(lapsed['2026-07-10'].tent, 1, 'an abandoned checkout releases the site on its own');
});

test('availability never goes negative when a type is oversold', () => {
  const occupancy = Array.from({ length: 5 }, () => ({
    siteTypeId: 'tent',
    arrival: '2026-07-10',
    departure: '2026-07-11',
    state: 'confirmed',
  }));
  const grid = computeAvailability(tiny, occupancy, '2026-07-10', '2026-07-10', NOW);
  assert.equal(grid['2026-07-10'].tent, 0);
});

test('dates outside the season are closed', () => {
  const grid = computeAvailability(tiny, [], '2026-04-20', '2026-04-26', NOW);
  assert.equal(grid['2026-04-24']['full-service'], 0);
  assert.equal(grid['2026-04-25']['full-service'], 2);
});

test('a stay is only bookable when every night has a site free', () => {
  const grid = computeAvailability(
    tiny,
    [{ siteTypeId: 'tent', arrival: '2026-07-11', departure: '2026-07-12', state: 'confirmed' }],
    '2026-07-10',
    '2026-07-14',
    NOW
  );
  assert.equal(isStayAvailable(grid, 'tent', '2026-07-10', '2026-07-11'), true);
  assert.equal(isStayAvailable(grid, 'tent', '2026-07-10', '2026-07-13'), false);
  assert.deepEqual(unavailableNights(grid, 'tent', '2026-07-10', '2026-07-13'), ['2026-07-11']);
});

test('the office can close sites with a calendar event titled BLOCK', () => {
  assert.deepEqual(parseBlock('BLOCK tent x2', tiny.siteTypes), [{ siteTypeId: 'tent', units: 2 }]);
  assert.deepEqual(parseBlock('block Full service', tiny.siteTypes), [{ siteTypeId: 'full-service', units: 1 }]);
  assert.equal(parseBlock('Dentist appointment', tiny.siteTypes), null, 'ordinary events must not close the campground');
  assert.equal(parseBlock('BLOCK something unrecognised', tiny.siteTypes), null);

  const all = parseBlock('BLOCK all — power out', tiny.siteTypes);
  assert.equal(all.length, 2);
  assert.equal(all[0].units, 2);
});

test('timed events on the calendar are ignored — only all-day stays count', () => {
  const meeting = {
    id: 'x',
    summary: 'BLOCK tent',
    start: { dateTime: '2026-07-10T09:00:00Z' },
    end: { dateTime: '2026-07-10T10:00:00Z' },
  };
  assert.deepEqual(eventToRecords(meeting, tiny.siteTypes), []);
});
