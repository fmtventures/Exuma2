'use strict';

const { eachNight, nights } = require('./dates');

/**
 * All money is handled in cents. Rates are configured in dollars because that
 * is how the office thinks about them, and converted once, here.
 *
 * A rate can be a single number, or a number per season:
 *
 *   "nightly": 52                      the same all year
 *   "nightly": { "high": 63, "low": 54 }   peak summer and the shoulders
 *
 * A season with no price is not an invitation to guess: the stay is refused
 * with a message telling the guest to call, and the office can fill the number
 * in later without touching any code.
 */

const toCents = (dollars) => Math.round(Number(dollars) * 100);

function fail(message, code, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function siteType(rates, siteTypeId) {
  const type = rates.siteTypes.find((t) => t.id === siteTypeId);
  if (!type) throw fail(`Unknown site type: ${siteTypeId}`, 'unknown_site_type');
  return type;
}

function inRange(date, [from, to]) {
  const md = date.slice(5);
  return md >= from && md <= to;
}

/** Which season a given night falls in — or null when the campground is shut. */
function seasonOf(rates, date) {
  for (const season of rates.seasons || []) {
    if ((season.ranges || []).some((range) => inRange(date, range))) return season.id;
  }
  return (rates.seasons || []).length ? null : 'all';
}

function seasonName(rates, seasonId) {
  const season = (rates.seasons || []).find((s) => s.id === seasonId);
  return season ? season.name.toLowerCase() : '';
}

/** A rate that may be flat or per season, in dollars, or null when unset. */
function resolve(rate, seasonId) {
  if (rate == null) return null;
  if (typeof rate === 'number') return rate > 0 ? rate : null;
  const value = rate[seasonId];
  return typeof value === 'number' && value > 0 ? value : null;
}

/** A site type is sellable online once it has a nightly rate for some season. */
function isPriced(rates, type) {
  const seasons = (rates.seasons || []).map((s) => s.id);
  if (!seasons.length) return resolve(type.nightly, 'all') != null;
  return seasons.some((id) => resolve(type.nightly, id) != null);
}

/**
 * Booking is open once *something* has a price. A single site type still
 * waiting on its rate does not shut the whole campground — it simply cannot be
 * chosen online, and the page shows it as a call-the-office type.
 */
function ratesConfigured(rates) {
  return rates.siteTypes.filter((t) => t.inventory > 0).some((t) => isPriced(rates, t));
}

/** Every night of the stay, with the season it falls in and what it costs. */
function nightlyPlan(rates, type, arrival, departure) {
  return eachNight(arrival, departure).map((night) => {
    const season = seasonOf(rates, night);
    const nightly = season == null ? null : resolve(type.nightly, season);
    return { night, season, cents: nightly == null ? null : toCents(nightly) };
  });
}

/**
 * Bill each run of same-season nights at whichever of its monthly, weekly or
 * nightly rate is kinder, then move on. A stay that crosses into a new season
 * is charged each part at its own rate — which is what a guest would work out
 * with a pencil, and what the office would charge at the desk.
 */
function priceRuns(rates, type, plan) {
  const lines = [];
  let i = 0;

  while (i < plan.length) {
    let j = i;
    while (j < plan.length && plan[j].season === plan[i].season) j++;

    const run = plan.slice(i, j);
    const seasonId = plan[i].season;
    const label = seasonName(rates, seasonId);
    const suffix = label ? ` (${label})` : '';
    const nightly = run[0].cents;
    let left = run.length;

    const monthly = resolve(type.monthly, seasonId);
    if (monthly && left >= 28 && toCents(monthly) < nightly * 28) {
      const months = Math.floor(left / 28);
      lines.push({
        label: `${months} month${months === 1 ? '' : 's'} at the monthly rate${suffix}`,
        qty: months, each: toCents(monthly), amount: months * toCents(monthly),
      });
      left -= months * 28;
    }

    const weekly = resolve(type.weekly, seasonId);
    if (weekly && left >= 7 && toCents(weekly) < nightly * 7) {
      const weeks = Math.floor(left / 7);
      lines.push({
        label: `${weeks} week${weeks === 1 ? '' : 's'} at the weekly rate${suffix}`,
        qty: weeks, each: toCents(weekly), amount: weeks * toCents(weekly),
      });
      left -= weeks * 7;
    }

    if (left > 0) {
      lines.push({
        label: `${left} night${left === 1 ? '' : 's'} at the nightly rate${suffix}`,
        qty: left, each: nightly, amount: nightly * left,
      });
    }

    i = j;
  }

  return lines;
}

/**
 * The deposit taken online. `greater_of` is the campground's own rule — one
 * night, or a share of the total, whichever is larger — and never more than the
 * whole bill.
 */
function depositCents(rates, { total, firstNightWithTax }) {
  const policy = rates.deposit || {};
  const mode = policy.mode || 'first_night';
  const percent = policy.percent || 0.1;
  const share = Math.round(total * percent);

  if (mode === 'full') return total;
  if (mode === 'percent') return Math.min(total, share);
  if (mode === 'greater_of') return Math.min(total, Math.max(firstNightWithTax, share));
  return Math.min(total, firstNightWithTax);
}

/**
 * Price a stay. Returns every line the guest will see, so the summary on the
 * website and the amount charged by Stripe come from one calculation.
 */
function quote(rates, { siteTypeId, arrival, departure, guests = 1 }) {
  const type = siteType(rates, siteTypeId);
  const plan = nightlyPlan(rates, type, arrival, departure);

  const unpriced = plan.filter((night) => night.cents == null);
  if (unpriced.length) {
    const which = seasonName(rates, unpriced[0].season);
    throw fail(
      which
        ? `We haven't published a ${which} rate for ${type.name} yet — please call the campground`
        : `No rate is set for ${type.name} yet`,
      'rates_unconfigured',
      409
    );
  }

  const n = nights(arrival, departure);
  const lines = priceRuns(rates, type, plan);

  const extras = rates.extras || {};
  const included = extras.guestsIncluded || Infinity;
  const extraGuests = Math.max(0, guests - included);
  if (extraGuests > 0 && extras.extraGuestNightly) {
    const each = toCents(extras.extraGuestNightly);
    lines.push({
      label: `${extraGuests} extra guest${extraGuests === 1 ? '' : 's'} × ${n} night${n === 1 ? '' : 's'}`,
      qty: extraGuests * n, each, amount: each * extraGuests * n,
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const tax = Math.round(subtotal * rates.taxRate);
  const total = subtotal + tax;

  const firstNight = plan[0].cents;
  const firstNightWithTax = firstNight + Math.round(firstNight * rates.taxRate);
  const deposit = depositCents(rates, { total, firstNightWithTax });

  return {
    siteTypeId: type.id,
    siteTypeName: type.name,
    arrival,
    departure,
    nights: n,
    guests,
    seasons: [...new Set(plan.map((p) => p.season))],
    currency: rates.currency,
    lines,
    subtotal,
    taxLabel: rates.taxLabel,
    taxRate: rates.taxRate,
    tax,
    total,
    deposit,
    balance: total - deposit,
    depositMode: (rates.deposit && rates.deposit.mode) || 'first_night',
  };
}

/** The lowest published nightly rate for a type — what "from $43" means. */
function fromRate(rates, type) {
  const seasons = (rates.seasons || []).map((s) => s.id);
  const prices = (seasons.length ? seasons : ['all'])
    .map((id) => resolve(type.nightly, id))
    .filter((price) => price != null);
  return prices.length ? Math.min(...prices) : null;
}

module.exports = {
  quote,
  priceRuns,
  nightlyPlan,
  seasonOf,
  seasonName,
  resolve,
  isPriced,
  ratesConfigured,
  fromRate,
  siteType,
  toCents,
};
