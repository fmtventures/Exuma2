'use strict';

/**
 * Calendar dates here are plain "YYYY-MM-DD" strings, never Date objects with a
 * time zone attached. A campground stay is a run of nights on a wall calendar:
 * arriving the 5th and leaving the 8th is three nights no matter what time zone
 * the browser, the server or Google happens to be in. All arithmetic goes
 * through UTC so a daylight-saving change can never shift a night.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function assertDate(value, label) {
  if (!isDate(value)) {
    const err = new Error(`${label} must be a calendar date in YYYY-MM-DD form`);
    err.status = 400;
    err.code = 'bad_date';
    throw err;
  }
  return value;
}

function toUTC(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(date, days) {
  return fromUTC(toUTC(date) + days * 86400000);
}

/** Nights between arrival and departure; departure is exclusive. */
function nights(arrival, departure) {
  return Math.round((toUTC(departure) - toUTC(arrival)) / 86400000);
}

/** Every night slept, i.e. arrival up to but not including departure. */
function eachNight(arrival, departure) {
  const out = [];
  for (let d = arrival; d < departure; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Every date in an inclusive range — for painting a calendar grid. */
function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function today(clock = Date.now()) {
  return fromUTC(clock - (clock % 86400000));
}

/**
 * Whether a date falls inside the operating season. `opens`/`closes` are
 * "MM-DD" so they carry across years without editing.
 */
function inSeason(date, season) {
  if (!season || !season.opens || !season.closes) return true;
  const md = date.slice(5);
  return md >= season.opens && md <= season.closes;
}

module.exports = {
  isDate,
  assertDate,
  addDays,
  nights,
  eachNight,
  eachDay,
  today,
  inSeason,
};
