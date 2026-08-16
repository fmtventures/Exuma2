/**
 * Cart pricing.
 *
 * One pure function turns a set of lines, discounts, shipping and tax rules
 * into a priced cart. It is deterministic and side-effect free, so the same
 * inputs always produce byte-identical output — a cart priced in the browser,
 * re-priced on the server at checkout, and re-priced again by a webhook
 * reconciling against the payment provider must agree exactly, or orders fail
 * intermittently in ways nobody can reproduce.
 *
 * The order of operations is fixed and documented because it is a commercial
 * decision, not an implementation detail. Applying an order-level percentage
 * before or after a line-level fixed discount gives different totals, and a
 * merchant needs to be able to explain the number to a customer:
 *
 *   1. Line subtotal              unit price × quantity
 *   2. Line discounts             applied to their own line, capped at it
 *   3. Order discounts            allocated across lines by discounted value
 *   4. Shipping                   quoted, then free-shipping discounts
 *   5. Tax                        on discounted line value + shipping share
 *   6. Total
 *
 * Every discount is allocated back onto lines rather than held as an order
 * total adjustment. That is what makes partial refunds and returns correct:
 * refunding one line of a discounted order must return that line's share of
 * the discount, and you cannot compute that afterwards from a lump sum.
 */

import { err } from '../core/errors.ts';
import {
  add, allocate, isNegative, maxMoney, minMoney, money, multiply,
  percentOf, roundMinor, scale, subtract, sum, zero,
  type CurrencyCode, type Money, type RoundingMode,
} from './money.ts';

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface PricingLine {
  id: string;
  /** Unit price before any discount, in the cart currency. */
  unitPrice: Money;
  quantity: number;
  /** Groups lines for tax rules and discount eligibility. */
  taxClass?: string;
  productId?: string;
  collectionIds?: string[];
  /** Excluded from order-level discounts (gift cards, deposits). */
  discountable?: boolean;
  /** Not shipped, so it takes no share of shipping and its tax ignores it. */
  requiresShipping?: boolean;
}

export type DiscountValue =
  | { kind: 'percentage'; percent: number }
  | { kind: 'fixed'; amount: Money }
  /** Shipping becomes free; recorded as a discount so the order still balances. */
  | { kind: 'free_shipping' };

export interface Discount {
  id: string;
  code?: string;
  label: string;
  value: DiscountValue;
  scope: 'order' | 'line';
  /** Line scope only: which lines it applies to. Empty means every line. */
  appliesToLineIds?: string[];
  /** Order scope only: minimum discountable subtotal before it is offered. */
  minimumSubtotal?: Money;
  /** Discounts combine unless one of them forbids it. */
  exclusive?: boolean;
  /** Lower runs first. Ties break on id so ordering is total and stable. */
  priority?: number;
}

export interface TaxRate {
  id: string;
  label: string;
  /** Fractional rate: 0.05 is 5%. */
  rate: number;
  /** Restricts the rate to lines carrying this tax class. */
  taxClass?: string;
  /**
   * Charged on top of the running taxed amount rather than the net amount.
   * Rare, and wrong for most jurisdictions — Canadian GST/PST are both on
   * net — but required where it does apply.
   */
  compound?: boolean;
  /** Also applies to the shipping charge. */
  appliesToShipping?: boolean;
}

export interface PricingInput {
  currency: CurrencyCode;
  lines: PricingLine[];
  discounts?: Discount[];
  shipping?: Money;
  taxRates?: TaxRate[];
  /**
   * Unit prices already include tax (normal in the UK and EU). Tax is then
   * extracted from the price rather than added to it, and the customer-facing
   * total equals the sum of the listed prices.
   */
  taxInclusive?: boolean;
  /** Tax authorities differ; the merchant's jurisdiction decides. */
  taxRounding?: RoundingMode;
}

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

export interface AppliedDiscount {
  discountId: string;
  code?: string;
  label: string;
  amount: Money;
}

export interface PricedLine {
  id: string;
  unitPrice: Money;
  quantity: number;
  /** unitPrice × quantity, before anything is taken off. */
  subtotal: Money;
  discounts: AppliedDiscount[];
  discountTotal: Money;
  /** subtotal − discountTotal. Never negative. */
  net: Money;
  taxes: { rateId: string; label: string; amount: Money }[];
  taxTotal: Money;
  /** What this line contributes to the order total. */
  total: Money;
}

export interface PricedCart {
  currency: CurrencyCode;
  lines: PricedLine[];
  /** Sum of line subtotals before discounts. */
  subtotal: Money;
  discounts: AppliedDiscount[];
  discountTotal: Money;
  shipping: Money;
  shippingTax: Money;
  taxTotal: Money;
  /** Tax already inside the listed prices, shown for information only. */
  taxIncludedInPrices: Money;
  total: Money;
  /** Discounts offered but not applied, with the reason — shown in the UI. */
  rejectedDiscounts: { discountId: string; code?: string; reason: string }[];
}

/* ------------------------------------------------------------------ */
/* Pricing                                                             */
/* ------------------------------------------------------------------ */

export function priceCart(input: PricingInput): PricedCart {
  const currency = input.currency.toUpperCase();
  const taxRounding = input.taxRounding ?? 'half_even';
  const rejected: PricedCart['rejectedDiscounts'] = [];

  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      throw err('VALIDATION_FAILED', `line ${line.id} has a non-whole quantity`);
    }
    if (line.unitPrice.currency !== currency) {
      throw err('VALIDATION_FAILED', `line ${line.id} is priced in ${line.unitPrice.currency}, cart is ${currency}`);
    }
  }

  /* 1. Line subtotals ---------------------------------------------- */

  const state = input.lines.map((line) => ({
    line,
    subtotal: multiply(line.unitPrice, line.quantity),
    discounts: [] as AppliedDiscount[],
  }));

  const subtotal = sum(state.map((s) => s.subtotal), currency);

  /* 2 & 3. Discounts ------------------------------------------------ */

  const ordered = [...(input.discounts ?? [])].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id),
  );

  // An exclusive discount suppresses every other one. Resolving this before
  // applying anything keeps the outcome independent of evaluation order.
  const exclusive = ordered.find((d) => d.exclusive);
  const candidates = exclusive ? [exclusive] : ordered;
  if (exclusive) {
    for (const d of ordered) {
      if (d.id !== exclusive.id) {
        rejected.push({ discountId: d.id, ...(d.code ? { code: d.code } : {}), reason: `cannot combine with ${exclusive.label}` });
      }
    }
  }

  let freeShipping = false;

  for (const discount of candidates) {
    if (discount.value.kind === 'free_shipping') {
      freeShipping = true;
      continue;
    }

    if (discount.scope === 'line') {
      const targets = state.filter((s) =>
        !discount.appliesToLineIds?.length || discount.appliesToLineIds.includes(s.line.id));
      if (targets.length === 0) {
        rejected.push({ discountId: discount.id, ...(discount.code ? { code: discount.code } : {}), reason: 'no matching items in the cart' });
        continue;
      }
      for (const target of targets) {
        const remaining = subtract(target.subtotal, sumApplied(target.discounts, currency));
        const wanted = discount.value.kind === 'percentage'
          ? percentOf(remaining, discount.value.percent)
          : discount.value.amount;
        // A discount can never exceed what is left on the line, or the line
        // goes negative and the order pays the customer to shop.
        const amount = minMoney(maxMoney(wanted, zero(currency)), remaining);
        if (amount.amount > 0) {
          target.discounts.push(appliedFrom(discount, amount));
        }
      }
      continue;
    }

    /* Order scope: allocate across eligible lines. */
    const eligible = state.filter((s) => s.line.discountable !== false);
    const eligibleNet = eligible.map((s) => subtract(s.subtotal, sumApplied(s.discounts, currency)));
    const eligibleTotal = sum(eligibleNet, currency);

    if (eligibleTotal.amount <= 0) {
      rejected.push({ discountId: discount.id, ...(discount.code ? { code: discount.code } : {}), reason: 'nothing left to discount' });
      continue;
    }
    if (discount.minimumSubtotal && eligibleTotal.amount < discount.minimumSubtotal.amount) {
      rejected.push({
        discountId: discount.id,
        ...(discount.code ? { code: discount.code } : {}),
        reason: `order must reach ${discount.minimumSubtotal.amount / 10 ** 2} before this applies`,
      });
      continue;
    }

    const wanted = discount.value.kind === 'percentage'
      ? percentOf(eligibleTotal, discount.value.percent)
      : discount.value.amount;
    const amount = minMoney(maxMoney(wanted, zero(currency)), eligibleTotal);
    if (amount.amount === 0) continue;

    // Allocated by remaining line value so the parts sum exactly to the
    // discount — the reason a 33.33% order discount still balances.
    const shares = allocate(amount, eligibleNet.map((m) => m.amount));
    eligible.forEach((s, i) => {
      const share = shares[i];
      if (share && share.amount > 0) s.discounts.push(appliedFrom(discount, share));
    });
  }

  /* 4. Shipping ----------------------------------------------------- */

  const quotedShipping = input.shipping ?? zero(currency);
  const shipping = freeShipping ? zero(currency) : quotedShipping;
  const shippingDiscount = subtract(quotedShipping, shipping);

  /* 5. Tax ---------------------------------------------------------- */

  const rates = input.taxRates ?? [];
  const shippable = state.filter((s) => s.line.requiresShipping !== false);
  const shippableNet = shippable.map((s) => subtract(s.subtotal, sumApplied(s.discounts, currency)));
  // Shipping is apportioned across the lines that are actually being shipped,
  // so a cart mixing a download and a physical item taxes shipping only where
  // the physical item's rate applies.
  const shippingShares = shippable.length > 0 && shipping.amount !== 0
    ? allocate(shipping, shippableNet.map((m) => m.amount))
    : shippable.map(() => zero(currency));

  const priced: PricedLine[] = state.map((s) => {
    const discountTotal = sumApplied(s.discounts, currency);
    const net = subtract(s.subtotal, discountTotal);
    const shipIndex = shippable.indexOf(s);
    const shipShare = shipIndex >= 0 ? (shippingShares[shipIndex] ?? zero(currency)) : zero(currency);

    const applicable = rates.filter((r) => !r.taxClass || r.taxClass === s.line.taxClass);
    const taxes: PricedLine['taxes'] = [];

    if (input.taxInclusive) {
      // Prices already contain tax. Extract it rather than adding: for a
      // combined rate r, tax = gross × r / (1 + r). Adding r to a
      // tax-inclusive price overcharges every order by r².
      const combined = applicable.reduce((acc, r) => acc + r.rate, 0);
      const grossForTax = add(net, applicable.some((r) => r.appliesToShipping) ? shipShare : zero(currency));
      const totalTax = combined === 0 ? zero(currency)
        : money(roundMinor((grossForTax.amount * combined) / (1 + combined), taxRounding), currency);
      // Split the extracted total across the rates by their share, so a
      // GST/PST breakdown still sums to the extracted amount exactly.
      const parts = applicable.length > 0 && totalTax.amount !== 0
        ? allocate(totalTax, applicable.map((r) => r.rate))
        : applicable.map(() => zero(currency));
      applicable.forEach((r, i) => taxes.push({ rateId: r.id, label: r.label, amount: parts[i] ?? zero(currency) }));
    } else {
      let base = add(net, zero(currency));
      let running = zero(currency);
      for (const r of applicable) {
        const taxable = add(r.appliesToShipping ? add(base, shipShare) : base, r.compound ? running : zero(currency));
        const amount = scale(taxable, r.rate, taxRounding);
        taxes.push({ rateId: r.id, label: r.label, amount });
        running = add(running, amount);
      }
      base = net;
    }

    const taxTotal = sum(taxes.map((t) => t.amount), currency);
    const lineTotal = input.taxInclusive ? net : add(net, taxTotal);

    return {
      id: s.line.id,
      unitPrice: s.line.unitPrice,
      quantity: s.line.quantity,
      subtotal: s.subtotal,
      discounts: s.discounts,
      discountTotal,
      net,
      taxes,
      taxTotal,
      total: lineTotal,
    };
  });

  /* 6. Totals ------------------------------------------------------- */

  const lineTaxTotal = sum(priced.map((l) => l.taxTotal), currency);
  const shippingTaxable = rates.some((r) => r.appliesToShipping);
  const shippingTax = shippingTaxable || input.taxInclusive ? zero(currency) : zero(currency);

  const discountTotal = add(
    sum(priced.map((l) => l.discountTotal), currency),
    shippingDiscount,
  );

  const orderDiscounts = mergeApplied(
    priced.flatMap((l) => l.discounts),
    shippingDiscount.amount > 0
      ? [{ discountId: 'free_shipping', label: 'Free shipping', amount: shippingDiscount }]
      : [],
    currency,
  );

  const netTotal = sum(priced.map((l) => l.net), currency);
  const total = input.taxInclusive
    ? add(netTotal, shipping)
    : add(add(netTotal, shipping), lineTaxTotal);

  return {
    currency,
    lines: priced,
    subtotal,
    discounts: orderDiscounts,
    discountTotal,
    shipping,
    shippingTax,
    taxTotal: lineTaxTotal,
    taxIncludedInPrices: input.taxInclusive ? lineTaxTotal : zero(currency),
    total,
    rejectedDiscounts: rejected,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function appliedFrom(d: Discount, amount: Money): AppliedDiscount {
  return { discountId: d.id, ...(d.code ? { code: d.code } : {}), label: d.label, amount };
}

function sumApplied(list: AppliedDiscount[], currency: CurrencyCode): Money {
  return sum(list.map((d) => d.amount), currency);
}

/** Roll per-line applications back up into one row per discount. */
function mergeApplied(
  fromLines: AppliedDiscount[],
  extra: AppliedDiscount[],
  currency: CurrencyCode,
): AppliedDiscount[] {
  const byId = new Map<string, AppliedDiscount>();
  for (const d of [...fromLines, ...extra]) {
    const existing = byId.get(d.discountId);
    byId.set(d.discountId, existing
      ? { ...existing, amount: add(existing.amount, d.amount) }
      : { ...d });
  }
  return [...byId.values()];
}

/**
 * Assert that a priced cart balances.
 *
 * Exported and called from tests and from the checkout path, because a total
 * that disagrees with the sum of its lines by one minor unit is the single
 * most expensive bug this module can ship: it reconciles fine in aggregate and
 * fails one order in a thousand.
 */
export function assertBalances(cart: PricedCart): void {
  const linesTotal = sum(cart.lines.map((l) => l.total), cart.currency);
  const expected = add(linesTotal, cart.shipping);
  if (expected.amount !== cart.total.amount) {
    throw err('INTERNAL',
      `priced cart does not balance: lines+shipping ${expected.amount} vs total ${cart.total.amount}`);
  }
  for (const line of cart.lines) {
    if (isNegative(line.net)) {
      throw err('INTERNAL', `line ${line.id} has a negative net after discounts`);
    }
    const check = subtract(line.subtotal, line.discountTotal);
    if (check.amount !== line.net.amount) {
      throw err('INTERNAL', `line ${line.id} net does not equal subtotal minus discounts`);
    }
  }
}
