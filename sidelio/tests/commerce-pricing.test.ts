import { describe, expect, it } from 'vitest';
import {
  add, allocate, formatMoney, minorUnitExponent, money, parseMoney,
  percentOf, roundMinor, split, sum, toDecimalString, zero,
} from '../src/commerce/money.ts';
import { assertBalances, priceCart, type Discount, type PricingInput, type TaxRate } from '../src/commerce/pricing.ts';

const CAD = 'CAD';
const c = (n: number) => money(n, CAD);

describe('money is integer minor units', () => {
  it('refuses a fractional amount rather than rounding silently', () => {
    expect(() => money(10.5, CAD)).toThrow(/integer minor unit/);
  });

  it('refuses to combine currencies instead of inventing a rate', () => {
    expect(() => add(money(100, 'CAD'), money(100, 'USD'))).toThrow(/cannot combine/);
  });

  it('knows currencies that are not two-decimal', () => {
    // Hardcoding *100 makes every yen price a hundred times too small.
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('KWD')).toBe(3);
    expect(minorUnitExponent('CAD')).toBe(2);
    expect(minorUnitExponent('zzz')).toBe(2);
  });

  it('formats to the currency own precision', () => {
    expect(toDecimalString(money(1250, 'CAD'))).toBe('12.50');
    expect(toDecimalString(money(1250, 'JPY'))).toBe('1250');
    expect(toDecimalString(money(1250, 'KWD'))).toBe('1.250');
    expect(toDecimalString(money(-5, 'CAD'))).toBe('-0.05');
    expect(formatMoney(money(120000, 'JPY'), 'en-CA')).not.toContain('.00');
  });
});

describe('rounding', () => {
  it('rounds halves away from zero for prices', () => {
    expect(roundMinor(2.5, 'half_up')).toBe(3);
    expect(roundMinor(-2.5, 'half_up')).toBe(-3);
  });

  it('rounds halves to even for tax', () => {
    // Always rounding up biases every total toward the merchant, which some
    // tax authorities disallow outright.
    expect(roundMinor(2.5, 'half_even')).toBe(2);
    expect(roundMinor(3.5, 'half_even')).toBe(4);
    expect(roundMinor(2.4, 'half_even')).toBe(2);
  });
});

describe('splitting money never loses or invents it', () => {
  it('splits evenly with the remainder distributed', () => {
    const parts = split(c(1000), 3);
    expect(parts.map((p) => p.amount)).toEqual([334, 333, 333]);
    expect(sum(parts, CAD).amount).toBe(1000);
  });

  it('splits negative amounts without drifting', () => {
    const parts = split(c(-1000), 3);
    expect(sum(parts, CAD).amount).toBe(-1000);
  });

  it('allocates by weight and still sums exactly', () => {
    const parts = allocate(c(1000), [1, 1, 1]);
    expect(sum(parts, CAD).amount).toBe(1000);

    const uneven = allocate(c(9999), [7, 3, 11, 1]);
    expect(sum(uneven, CAD).amount).toBe(9999);
  });

  it('is deterministic, so a re-price matches byte for byte', () => {
    // Reconciliation against a payment provider fails intermittently if the
    // same inputs can allocate two different ways.
    const a = allocate(c(1000), [1, 1, 1]).map((m) => m.amount);
    const b = allocate(c(1000), [1, 1, 1]).map((m) => m.amount);
    expect(a).toEqual(b);
  });

  it('splits evenly when every weight is zero', () => {
    const parts = allocate(c(300), [0, 0, 0]);
    expect(parts.map((p) => p.amount)).toEqual([100, 100, 100]);
  });

  it('rejects negative weights rather than producing nonsense', () => {
    expect(() => allocate(c(100), [1, -1])).toThrow(/non-negative/);
  });
});

describe('parsing merchant-entered prices', () => {
  it('reads the formats people actually type', () => {
    expect(parseMoney('12.50', CAD)).toMatchObject({ ok: true, value: { amount: 1250 } });
    expect(parseMoney('$1,234.50', CAD)).toMatchObject({ ok: true, value: { amount: 123450 } });
    expect(parseMoney('12', CAD)).toMatchObject({ ok: true, value: { amount: 1200 } });
    expect(parseMoney('12.5', CAD)).toMatchObject({ ok: true, value: { amount: 1250 } });
    expect(parseMoney('1.234,50', CAD)).toMatchObject({ ok: true, value: { amount: 123450 } });
    expect(parseMoney('(4.00)', CAD)).toMatchObject({ ok: true, value: { amount: -400 } });
  });

  it('resolves the ambiguous single-separator case on the separator itself', () => {
    // "1,234" and "19.999" are the same shape, so digit count cannot tell
    // them apart. A comma before three digits is a thousands group; a dot
    // before three digits is a decimal that needs rounding.
    expect(parseMoney('1,234', CAD)).toMatchObject({ ok: true, value: { amount: 123400 } });
    expect(parseMoney('19.999', CAD)).toMatchObject({ ok: true, value: { amount: 2000 } });
  });

  it('rounds rather than truncating, so nothing under-charges', () => {
    expect(parseMoney('19.999', CAD)).toMatchObject({ ok: true, value: { amount: 2000 } });
  });

  it('scales by the currency exponent', () => {
    expect(parseMoney('1200', 'JPY')).toMatchObject({ ok: true, value: { amount: 1200 } });
    expect(parseMoney('1.250', 'KWD')).toMatchObject({ ok: true, value: { amount: 1250 } });
  });

  it('fails rather than guessing at gibberish', () => {
    expect(parseMoney('', CAD).ok).toBe(false);
    expect(parseMoney('free', CAD).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

const line = (id: string, unit: number, qty = 1, extra: Record<string, unknown> = {}) =>
  ({ id, unitPrice: c(unit), quantity: qty, ...extra });

const GST: TaxRate = { id: 'gst', label: 'GST', rate: 0.05 };
const PST: TaxRate = { id: 'pst', label: 'PST', rate: 0.07 };

describe('cart pricing', () => {
  it('prices a simple cart with tax added on top', () => {
    const cart = priceCart({ currency: CAD, lines: [line('a', 1000, 2)], taxRates: [GST] });
    expect(cart.subtotal.amount).toBe(2000);
    expect(cart.taxTotal.amount).toBe(100);
    expect(cart.total.amount).toBe(2100);
    assertBalances(cart);
  });

  it('never lets a discount drive a line negative', () => {
    const cart = priceCart({
      currency: CAD,
      lines: [line('a', 500)],
      discounts: [{ id: 'd', label: '$50 off', scope: 'line', value: { kind: 'fixed', amount: c(5000) } }],
    });
    expect(cart.lines[0]!.net.amount).toBe(0);
    expect(cart.total.amount).toBe(0);
    assertBalances(cart);
  });

  it('allocates an order discount so the total still balances', () => {
    // Three lines and a third off is the classic case where naive per-line
    // rounding leaves a phantom cent between total and sum-of-lines.
    const cart = priceCart({
      currency: CAD,
      lines: [line('a', 1000), line('b', 1000), line('c', 1000)],
      discounts: [{ id: 'd', label: '33.33% off', scope: 'order', value: { kind: 'percentage', percent: 33.33 } }],
    });
    const allocated = sum(cart.lines.map((l) => l.discountTotal), CAD);
    expect(allocated.amount).toBe(cart.discountTotal.amount);
    assertBalances(cart);
  });

  it('keeps every discount attributed to a line so refunds are computable', () => {
    const cart = priceCart({
      currency: CAD,
      lines: [line('a', 3000), line('b', 1000)],
      discounts: [{ id: 'd', label: '10% off', scope: 'order', value: { kind: 'percentage', percent: 10 } }],
    });
    // The expensive line carries the larger share, so returning it refunds
    // the right amount rather than an even split.
    expect(cart.lines[0]!.discountTotal.amount).toBeGreaterThan(cart.lines[1]!.discountTotal.amount);
    expect(sum(cart.lines.map((l) => l.discountTotal), CAD).amount).toBe(400);
  });

  it('skips lines marked non-discountable', () => {
    const cart = priceCart({
      currency: CAD,
      lines: [line('gift', 5000, 1, { discountable: false }), line('b', 5000)],
      discounts: [{ id: 'd', label: '10% off', scope: 'order', value: { kind: 'percentage', percent: 10 } }],
    });
    expect(cart.lines[0]!.discountTotal.amount).toBe(0);
    expect(cart.lines[1]!.discountTotal.amount).toBe(500);
  });

  it('applies an exclusive discount alone and says why the others were dropped', () => {
    const discounts: Discount[] = [
      { id: 'x', label: 'Staff rate', scope: 'order', value: { kind: 'percentage', percent: 50 }, exclusive: true },
      { id: 'y', code: 'SPRING', label: 'Spring 10%', scope: 'order', value: { kind: 'percentage', percent: 10 } },
    ];
    const cart = priceCart({ currency: CAD, lines: [line('a', 1000)], discounts });
    expect(cart.discounts).toHaveLength(1);
    expect(cart.rejectedDiscounts[0]).toMatchObject({ discountId: 'y', code: 'SPRING' });
    expect(cart.rejectedDiscounts[0]!.reason).toMatch(/cannot combine/);
  });

  it('reports a discount that failed its minimum instead of silently dropping it', () => {
    const cart = priceCart({
      currency: CAD,
      lines: [line('a', 1000)],
      discounts: [{
        id: 'd', code: 'BIG', label: '10 off 100', scope: 'order',
        value: { kind: 'fixed', amount: c(1000) }, minimumSubtotal: c(10000),
      }],
    });
    expect(cart.discountTotal.amount).toBe(0);
    expect(cart.rejectedDiscounts[0]).toMatchObject({ discountId: 'd', code: 'BIG' });
  });

  it('orders discounts by priority, then id, so the outcome is stable', () => {
    const build = (ds: Discount[]) => priceCart({ currency: CAD, lines: [line('a', 1000)], discounts: ds });
    const a: Discount = { id: 'a', label: 'A', scope: 'line', value: { kind: 'percentage', percent: 50 }, priority: 2 };
    const b: Discount = { id: 'b', label: 'B', scope: 'line', value: { kind: 'fixed', amount: c(200) }, priority: 1 };
    expect(build([a, b]).total.amount).toBe(build([b, a]).total.amount);
  });
});

describe('shipping', () => {
  it('adds shipping to the total', () => {
    const cart = priceCart({ currency: CAD, lines: [line('a', 1000)], shipping: c(500) });
    expect(cart.total.amount).toBe(1500);
    assertBalances(cart);
  });

  it('records free shipping as a discount so the order still explains itself', () => {
    const cart = priceCart({
      currency: CAD,
      lines: [line('a', 1000)],
      shipping: c(500),
      discounts: [{ id: 'fs', code: 'SHIPFREE', label: 'Free shipping', scope: 'order', value: { kind: 'free_shipping' } }],
    });
    expect(cart.shipping.amount).toBe(0);
    expect(cart.discountTotal.amount).toBe(500);
    expect(cart.discounts.some((d) => d.amount.amount === 500)).toBe(true);
    expect(cart.total.amount).toBe(1000);
    assertBalances(cart);
  });

  it('taxes shipping only where the rate says it should', () => {
    const plain = priceCart({ currency: CAD, lines: [line('a', 1000)], shipping: c(1000), taxRates: [GST] });
    const taxed = priceCart({
      currency: CAD, lines: [line('a', 1000)], shipping: c(1000),
      taxRates: [{ ...GST, appliesToShipping: true }],
    });
    expect(plain.taxTotal.amount).toBe(50);
    expect(taxed.taxTotal.amount).toBe(100);
    assertBalances(taxed);
  });

  it('does not charge shipping against items that are not shipped', () => {
    const cart = priceCart({
      currency: CAD,
      lines: [line('download', 1000, 1, { requiresShipping: false }), line('boxed', 1000)],
      shipping: c(600),
      taxRates: [{ ...GST, appliesToShipping: true }],
    });
    // All the shipping lands on the physical line.
    expect(cart.lines[0]!.taxTotal.amount).toBe(50);
    expect(cart.lines[1]!.taxTotal.amount).toBe(80);
    assertBalances(cart);
  });
});

describe('tax', () => {
  it('applies several rates on the net amount, not on each other', () => {
    // GST and PST are both charged on the net price in Canada; compounding
    // them overcharges every order in the country.
    const cart = priceCart({ currency: CAD, lines: [line('a', 10000)], taxRates: [GST, PST] });
    expect(cart.lines[0]!.taxes.map((t) => t.amount.amount)).toEqual([500, 700]);
    expect(cart.taxTotal.amount).toBe(1200);
  });

  it('compounds only when the rate says to', () => {
    const cart = priceCart({
      currency: CAD, lines: [line('a', 10000)],
      taxRates: [GST, { ...PST, compound: true }],
    });
    expect(cart.lines[0]!.taxes[1]!.amount.amount).toBe(735); // 7% of 10500
  });

  it('extracts tax from prices that already include it', () => {
    // Adding the rate to a tax-inclusive price overcharges by r² on every
    // order. £120 at 20% contains £20 of tax, not £24.
    const cart = priceCart({
      currency: 'GBP',
      lines: [{ id: 'a', unitPrice: money(12000, 'GBP'), quantity: 1 }],
      taxRates: [{ id: 'vat', label: 'VAT', rate: 0.2 }],
      taxInclusive: true,
    });
    expect(cart.total.amount).toBe(12000);
    expect(cart.taxIncludedInPrices.amount).toBe(2000);
    assertBalances(cart);
  });

  it('splits extracted tax across rates so the breakdown still sums', () => {
    const cart = priceCart({
      currency: CAD, lines: [line('a', 11200)],
      taxRates: [GST, PST], taxInclusive: true,
    });
    const parts = sum(cart.lines[0]!.taxes.map((t) => t.amount), CAD);
    expect(parts.amount).toBe(cart.taxIncludedInPrices.amount);
    expect(cart.total.amount).toBe(11200);
  });

  it('restricts a rate to its tax class', () => {
    const cart = priceCart({
      currency: CAD,
      lines: [line('food', 1000, 1, { taxClass: 'zero' }), line('other', 1000)],
      taxRates: [{ ...GST, taxClass: undefined }, { id: 'lux', label: 'Luxury', rate: 0.1, taxClass: 'luxury' }],
    });
    expect(cart.lines[0]!.taxTotal.amount).toBe(50);
    expect(cart.lines[1]!.taxTotal.amount).toBe(50);
  });
});

describe('the cart always balances', () => {
  it('holds across a large randomised sweep', () => {
    // A one-minor-unit disagreement between total and sum-of-lines
    // reconciles fine in aggregate and fails one order in a thousand, so it
    // is worth hunting for exhaustively rather than by example.
    let checked = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const lines = Array.from({ length: (seed % 4) + 1 }, (_, i) =>
        line(`l${i}`, 97 * (i + 1) + (seed % 313), (seed % 3) + 1, {
          discountable: (seed + i) % 7 !== 0,
          requiresShipping: (seed + i) % 5 !== 0,
        }));
      const input: PricingInput = {
        currency: CAD,
        lines,
        shipping: c(seed % 900),
        taxRates: seed % 2 ? [GST, PST] : [{ ...GST, appliesToShipping: true }],
        taxInclusive: seed % 6 === 0,
        discounts: [
          { id: 'p', label: 'pct', scope: 'order', value: { kind: 'percentage', percent: (seed % 40) + 1 } },
          ...(seed % 3 === 0
            ? [{ id: 'f', label: 'fixed', scope: 'line' as const, value: { kind: 'fixed' as const, amount: c(seed % 500) } }]
            : []),
        ],
      };
      const cart = priceCart(input);
      expect(() => assertBalances(cart), `seed ${seed}`).not.toThrow();
      expect(cart.total.amount, `seed ${seed} went negative`).toBeGreaterThanOrEqual(0);
      checked++;
    }
    expect(checked).toBe(400);
  });

  it('rejects a line priced in another currency', () => {
    expect(() => priceCart({
      currency: CAD,
      lines: [{ id: 'a', unitPrice: money(100, 'USD'), quantity: 1 }],
    })).toThrow(/priced in USD/);
  });

  it('rejects a fractional quantity', () => {
    expect(() => priceCart({ currency: CAD, lines: [line('a', 100, 1.5)] })).toThrow(/non-whole quantity/);
  });

  it('prices an empty cart as zero rather than failing', () => {
    const cart = priceCart({ currency: CAD, lines: [], taxRates: [GST] });
    expect(cart.total.amount).toBe(0);
    expect(zero(CAD).amount).toBe(0);
    assertBalances(cart);
  });
});
