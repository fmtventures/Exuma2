/**
 * Money.
 *
 * Every amount in Sidelio is an integer count of the currency's minor unit —
 * cents, pence, yen. Floating point is never used for money anywhere in this
 * codebase: `0.1 + 0.2 !== 0.3` is not an acceptable property for a system
 * that issues invoices, and the error compounds through discounts and tax.
 *
 * Two things here are subtler than they look and cause most real-world
 * accounting bugs:
 *
 *  1. **Not every currency has two decimal places.** JPY and KRW have none,
 *     and several have three. Hardcoding `* 100` produces amounts a hundred
 *     times too small in Tokyo. Exponents are looked up per currency.
 *
 *  2. **Splitting money must not lose or invent it.** Allocating a $10.00
 *     discount across three lines naively gives 3 × 333 = 999, leaving a
 *     phantom cent that makes the order total disagree with the sum of its
 *     lines. Allocation here uses the largest-remainder method, so the parts
 *     always sum exactly to the whole.
 */

import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';

/** ISO 4217 code. Kept as a string so unlisted currencies still round-trip. */
export type CurrencyCode = string;

export interface Money {
  /** Integer amount in the currency's minor unit. May be negative. */
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/**
 * Minor-unit exponents that are not 2.
 *
 * Listing only the exceptions keeps this short and makes the default explicit;
 * an unknown currency is assumed to have two places, which is right far more
 * often than it is wrong and never silently scales by a factor of a hundred.
 */
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function minorUnitExponent(currency: CurrencyCode): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

export function money(amount: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(amount)) {
    throw err('VALIDATION_FAILED', `money amount must be an integer minor unit, got ${amount}`);
  }
  return { amount, currency: currency.toUpperCase() };
}

export const zero = (currency: CurrencyCode): Money => money(0, currency);

/**
 * Operations across currencies are a bug, not a conversion request. There is
 * no exchange rate in scope here, so mixing them fails loudly rather than
 * producing a number that looks plausible.
 */
function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw err('VALIDATION_FAILED', `cannot combine ${a.currency} with ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function sum(items: Money[], currency: CurrencyCode): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}

export function negate(m: Money): Money {
  return money(-m.amount, m.currency);
}

export function isZero(m: Money): boolean {
  return m.amount === 0;
}

export function isNegative(m: Money): boolean {
  return m.amount < 0;
}

export function compare(a: Money, b: Money): number {
  sameCurrency(a, b);
  return a.amount - b.amount;
}

export function maxMoney(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function minMoney(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

/** Multiply by a whole quantity. Exact — no rounding is possible or needed. */
export function multiply(m: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw err('VALIDATION_FAILED', `quantity must be a whole number, got ${quantity}`);
  }
  return money(m.amount * quantity, m.currency);
}

export type RoundingMode = 'half_up' | 'half_even' | 'down' | 'up';

/**
 * Round a fractional minor-unit value to an integer.
 *
 * `half_even` (banker's rounding) is the default for tax, because rounding
 * halves consistently upward biases every total in the merchant's favour and
 * several tax authorities require the even rule. `half_up` is the default for
 * prices, which is what a human expects when they read a price list.
 */
export function roundMinor(value: number, mode: RoundingMode = 'half_up'): number {
  if (Number.isInteger(value)) return value;
  switch (mode) {
    case 'down': return Math.trunc(value);
    case 'up': return value < 0 ? Math.floor(value) : Math.ceil(value);
    case 'half_even': {
      const floor = Math.floor(value);
      const diff = value - floor;
      if (diff > 0.5) return floor + 1;
      if (diff < 0.5) return floor;
      return floor % 2 === 0 ? floor : floor + 1;
    }
    case 'half_up':
    default: {
      // Symmetric around zero: -2.5 rounds to -3, matching how a refund of
      // half a cent is expected to behave.
      return value < 0 ? -Math.round(-value) : Math.round(value);
    }
  }
}

/** Scale by an arbitrary rate (a tax rate, a percentage discount). */
export function scale(m: Money, rate: number, mode: RoundingMode = 'half_up'): Money {
  if (!Number.isFinite(rate)) {
    throw err('VALIDATION_FAILED', 'rate must be a finite number');
  }
  return money(roundMinor(m.amount * rate, mode), m.currency);
}

/** Percentage of an amount, expressed in whole percent (12.5 means 12.5%). */
export function percentOf(m: Money, percent: number, mode: RoundingMode = 'half_up'): Money {
  return scale(m, percent / 100, mode);
}

/**
 * Split an amount into `parts` pieces that sum exactly to the original.
 *
 * The remainder is distributed one minor unit at a time from the front, so
 * £10.00 into 3 becomes [334, 333, 333] rather than three lots of 333 with a
 * penny unaccounted for.
 */
export function split(m: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw err('VALIDATION_FAILED', 'parts must be a positive whole number');
  }
  const base = Math.trunc(m.amount / parts);
  let remainder = m.amount - base * parts;
  const step = remainder < 0 ? -1 : 1;
  remainder = Math.abs(remainder);

  const out: Money[] = [];
  for (let i = 0; i < parts; i++) {
    const extra = i < remainder ? step : 0;
    out.push(money(base + extra, m.currency));
  }
  return out;
}

/**
 * Allocate an amount across weights so the parts sum exactly to the whole.
 *
 * Largest-remainder: each part takes its floored proportional share, then the
 * leftover minor units go to the parts with the largest discarded fractions.
 * This is the method that keeps an order total equal to the sum of its lines
 * after a percentage discount, which naive per-line rounding does not.
 *
 * Ties break toward the earlier index so the result is deterministic — an
 * order re-priced from the same inputs must produce byte-identical lines, or
 * reconciliation against a payment provider fails intermittently.
 */
export function allocate(m: Money, weights: number[]): Money[] {
  if (weights.length === 0) {
    throw err('VALIDATION_FAILED', 'allocate needs at least one weight');
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw err('VALIDATION_FAILED', 'weights must be finite and non-negative');
  }

  const total = weights.reduce((a, b) => a + b, 0);
  // Every weight zero is a real case — an order of entirely free lines — and
  // an even split is the only defensible answer.
  if (total === 0) return split(m, weights.length);

  const exact = weights.map((w) => (m.amount * w) / total);
  const floored = exact.map((v) => Math.trunc(v));
  const assigned = floored.reduce((a, b) => a + b, 0);
  let remainder = m.amount - assigned;
  const step = remainder < 0 ? -1 : 1;
  remainder = Math.abs(remainder);

  const order = exact
    .map((v, i) => ({ i, frac: Math.abs(v - Math.trunc(v)) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = [...floored];
  for (let k = 0; k < remainder; k++) {
    const target = order[k % order.length];
    if (target) out[target.i] = (out[target.i] as number) + step;
  }
  return out.map((amount) => money(amount, m.currency));
}

/* ------------------------------------------------------------------ */
/* Parsing and formatting                                              */
/* ------------------------------------------------------------------ */

/**
 * Parse a human-entered price into minor units.
 *
 * Accepts what merchants actually type: `1,234.50`, `£12`, `12.5`, `1.234,50`
 * in locales that group with dots. The ambiguous case — a single separator
 * with exactly three digits after it, like `1,234` — is read as a thousands
 * group, because a merchant entering a price of one and a bit rarely writes
 * three decimal places in a two-decimal currency.
 */
export function parseMoney(input: string, currency: CurrencyCode): Result<Money> {
  const raw = String(input).trim();
  if (raw === '') return fail(err('VALIDATION_FAILED', 'price is empty'));

  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  let body = raw.replace(/^[-(]|\)$/g, '');
  body = body.replace(/[^\d.,]/g, '');
  if (body === '') return fail(err('VALIDATION_FAILED', `cannot read a price from "${input}"`));

  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  let decimalSep = '';
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const after = body.length - body.lastIndexOf(sep) - 1;
    // A single separator is genuinely ambiguous: "1,234" and "19.999" have
    // identical shape, so digit count alone cannot separate them. Resolve on
    // the separator character instead — a comma before three digits is a
    // thousands group almost everywhere, while a dot before three digits is
    // far more often a decimal that needs rounding. A count matching the
    // currency's own exponent is always decimal, which is what makes KWD's
    // three places work.
    if (after === minorUnitExponent(currency)) decimalSep = sep;
    else if (sep === ',' && after === 3) decimalSep = '';
    else decimalSep = sep;
  }

  // Strip the grouping separator by splitting on it — building a RegExp from
  // a character that may itself need escaping is how this went wrong once.
  let normalized: string;
  if (decimalSep === '') {
    normalized = body.replace(/[.,]/g, '');
  } else {
    const groupSep = decimalSep === '.' ? ',' : '.';
    normalized = body.split(groupSep).join('').replace(decimalSep, '.');
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return fail(err('VALIDATION_FAILED', `cannot read a price from "${input}"`));
  }

  const exp = minorUnitExponent(currency);
  // Round rather than truncate: a merchant typing 19.999 means 20.00, not
  // 19.99, and truncation quietly under-charges on every sale.
  const minor = roundMinor(value * 10 ** exp, 'half_up');
  return ok(money(negative ? -minor : minor, currency));
}

/** Decimal string with the currency's own number of places — never localized. */
export function toDecimalString(m: Money): string {
  const exp = minorUnitExponent(m.currency);
  const sign = m.amount < 0 ? '-' : '';
  const abs = Math.abs(m.amount).toString().padStart(exp + 1, '0');
  if (exp === 0) return `${sign}${abs}`;
  return `${sign}${abs.slice(0, -exp)}.${abs.slice(-exp)}`;
}

/**
 * Display string for a locale.
 *
 * Uses Intl so a Japanese price shows as ¥1,200 and not ¥1,200.00, then falls
 * back to a plain decimal where Intl or the currency is unavailable — a price
 * that fails to render is worse than one rendered plainly.
 */
export function formatMoney(m: Money, locale = 'en-CA'): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: m.currency,
      minimumFractionDigits: minorUnitExponent(m.currency),
    }).format(m.amount / 10 ** minorUnitExponent(m.currency));
  } catch {
    return `${m.currency} ${toDecimalString(m)}`;
  }
}
