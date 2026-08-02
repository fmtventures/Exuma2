'use strict';

const { nights } = require('./dates');

/**
 * All money is handled in cents. Rates are configured in dollars because that
 * is how the office thinks about them, and converted once, here.
 */

const toCents = (dollars) => Math.round(Number(dollars) * 100);

function siteType(rates, siteTypeId) {
  const type = rates.siteTypes.find((t) => t.id === siteTypeId);
  if (!type) {
    const err = new Error(`Unknown site type: ${siteTypeId}`);
    err.status = 400;
    err.code = 'unknown_site_type';
    throw err;
  }
  return type;
}

/** A site type is sellable online only once someone has entered its nightly rate. */
function isPriced(type) {
  return typeof type.nightly === 'number' && type.nightly > 0;
}

function ratesConfigured(rates) {
  return rates.siteTypes.filter((t) => t.inventory > 0).every(isPriced);
}

/**
 * Cheapest way to cover `n` nights given nightly, weekly and monthly rates.
 * A four-week stay should be billed as a month if that is kinder, and a nine
 * night stay as a week plus two nights — guests should not have to know to ask.
 */
function bestRate(type, n) {
  const nightly = toCents(type.nightly);
  const weekly = typeof type.weekly === 'number' && type.weekly > 0 ? toCents(type.weekly) : null;
  const monthly = typeof type.monthly === 'number' && type.monthly > 0 ? toCents(type.monthly) : null;

  const options = [{ basis: 'nightly', amount: nightly * n, lines: [{ label: `${n} night${n === 1 ? '' : 's'} at nightly rate`, qty: n, each: nightly, amount: nightly * n }] }];

  if (weekly && n >= 7) {
    const weeks = Math.floor(n / 7);
    const rem = n % 7;
    options.push({
      basis: 'weekly',
      amount: weeks * weekly + rem * nightly,
      lines: [
        { label: `${weeks} week${weeks === 1 ? '' : 's'} at weekly rate`, qty: weeks, each: weekly, amount: weeks * weekly },
        ...(rem ? [{ label: `${rem} extra night${rem === 1 ? '' : 's'}`, qty: rem, each: nightly, amount: rem * nightly }] : []),
      ],
    });
  }

  if (monthly && n >= 28) {
    const months = Math.floor(n / 28);
    let rem = n % 28;
    const lines = [{ label: `${months} month${months === 1 ? '' : 's'} at monthly rate`, qty: months, each: monthly, amount: months * monthly }];
    let amount = months * monthly;
    if (weekly && rem >= 7) {
      const weeks = Math.floor(rem / 7);
      lines.push({ label: `${weeks} week${weeks === 1 ? '' : 's'} at weekly rate`, qty: weeks, each: weekly, amount: weeks * weekly });
      amount += weeks * weekly;
      rem = rem % 7;
    }
    if (rem) {
      lines.push({ label: `${rem} extra night${rem === 1 ? '' : 's'}`, qty: rem, each: nightly, amount: rem * nightly });
      amount += rem * nightly;
    }
    options.push({ basis: 'monthly', amount, lines });
  }

  return options.reduce((best, o) => (o.amount < best.amount ? o : best));
}

function depositCents(rates, { total, firstNightWithTax }) {
  const mode = (rates.deposit && rates.deposit.mode) || 'first_night';
  if (mode === 'full') return total;
  if (mode === 'percent') {
    const pct = (rates.deposit && rates.deposit.percent) || 0.5;
    return Math.min(total, Math.round(total * pct));
  }
  return Math.min(total, firstNightWithTax);
}

/**
 * Price a stay. Returns every line the guest will see, so the summary on the
 * website and the amount charged by Stripe come from one calculation.
 */
function quote(rates, { siteTypeId, arrival, departure, guests = 1 }) {
  const type = siteType(rates, siteTypeId);
  if (!isPriced(type)) {
    const err = new Error(`No rate is set for ${type.name} yet`);
    err.status = 409;
    err.code = 'rates_unconfigured';
    throw err;
  }

  const n = nights(arrival, departure);
  const rate = bestRate(type, n);
  const lines = rate.lines.slice();

  const extras = rates.extras || {};
  const included = extras.guestsIncluded || Infinity;
  const extraGuests = Math.max(0, guests - included);
  if (extraGuests > 0 && extras.extraGuestNightly) {
    const each = toCents(extras.extraGuestNightly);
    const amount = each * extraGuests * n;
    lines.push({
      label: `${extraGuests} extra guest${extraGuests === 1 ? '' : 's'} × ${n} night${n === 1 ? '' : 's'}`,
      qty: extraGuests * n,
      each,
      amount,
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const tax = Math.round(subtotal * rates.taxRate);
  const total = subtotal + tax;

  const nightlyCents = toCents(type.nightly);
  const firstNightWithTax = nightlyCents + Math.round(nightlyCents * rates.taxRate);
  const deposit = depositCents(rates, { total, firstNightWithTax });

  return {
    siteTypeId: type.id,
    siteTypeName: type.name,
    arrival,
    departure,
    nights: n,
    guests,
    basis: rate.basis,
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

module.exports = { quote, bestRate, isPriced, ratesConfigured, siteType, toCents };
