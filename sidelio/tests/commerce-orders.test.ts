import { describe, expect, it } from 'vitest';
import { asId, type SiteId } from '../src/core/ids.ts';
import { money } from '../src/commerce/money.ts';
import { priceCart } from '../src/commerce/pricing.ts';
import {
  availableFor, checkStock, levelKey, expireReservations, levelsFrom, lowStock,
  missingVariants, optionMatrix, validateProduct,
  type InventoryMovement, type Product, type Reservation, type Variant,
} from '../src/commerce/catalog.ts';
import {
  assertOrderConsistent, cancelOrder, capturePayment, capturedTotal, createOrder,
  fulfil, netReceived, outstandingBalance, refundPayment, refundedTotal,
  restockMovementsFor, type Order,
} from '../src/commerce/orders.ts';

const SITE = asId<SiteId>('site_t');
const CAD = 'CAD';
const c = (n: number) => money(n, CAD);
let seq = 0;
const makeId = (prefix: string) => `${prefix}_${String(++seq).padStart(4, '0')}`;
const NOW = new Date('2026-03-01T10:00:00.000Z');

/* ------------------------------------------------------------------ */

const variant = (over: Partial<Variant> = {}): Variant => ({
  id: 'var_1', productId: 'prd_1', optionValues: [], price: c(2500),
  requiresShipping: true, trackInventory: true, allowBackorder: false, position: 0, ...over,
});

const product = (over: Partial<Product> = {}): Product => ({
  id: 'prd_1', siteId: SITE, title: 'Ridge cap', handle: 'ridge-cap', status: 'active',
  tags: [], options: [], variants: [variant()], imageAssetIds: [], collectionIds: [],
  updatedAt: NOW.toISOString(), ...over,
});

describe('catalog validation', () => {
  it('accepts a simple product with one implicit variant', () => {
    expect(validateProduct(product()).ok).toBe(true);
  });

  it('rejects a variant whose option count drifted from the product', () => {
    const p = product({
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [variant({ optionValues: [] })],
    });
    expect(validateProduct(p)).toMatchObject({ ok: false });
    expect(String((validateProduct(p) as { error: Error }).error.message)).toMatch(/option values/);
  });

  it('rejects two variants claiming the same combination', () => {
    const p = product({
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [variant({ id: 'a', optionValues: ['S'] }), variant({ id: 'b', optionValues: ['S'] })],
    });
    expect(validateProduct(p).ok).toBe(false);
  });

  it('rejects a duplicate SKU, which would make stock ambiguous', () => {
    const p = product({
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        variant({ id: 'a', optionValues: ['S'], sku: 'RC-1' }),
        variant({ id: 'b', optionValues: ['M'], sku: 'rc-1' }),
      ],
    });
    expect(validateProduct(p).ok).toBe(false);
  });

  it('rejects a compare-at price that advertises a saving that does not exist', () => {
    const p = product({ variants: [variant({ price: c(2500), compareAtPrice: c(2000) })] });
    const r = validateProduct(p);
    expect(r.ok).toBe(false);
    expect(String((r as { error: Error }).error.message)).toMatch(/saving that does not exist/);
  });

  it('refuses to mix currencies within one product', () => {
    const p = product({
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        variant({ id: 'a', optionValues: ['S'], price: money(100, 'CAD') }),
        variant({ id: 'b', optionValues: ['M'], price: money(100, 'USD') }),
      ],
    });
    expect(validateProduct(p).ok).toBe(false);
  });

  it('enumerates the option matrix and reports the gaps', () => {
    const p = product({
      options: [{ name: 'Size', values: ['S', 'M'] }, { name: 'Colour', values: ['Red', 'Blue'] }],
      variants: [variant({ id: 'a', optionValues: ['S', 'Red'] })],
    });
    expect(optionMatrix(p.options)).toHaveLength(4);
    expect(missingVariants(p)).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */

const movement = (over: Partial<InventoryMovement>): InventoryMovement => ({
  id: makeId('inv'), siteId: SITE, variantId: 'var_1', locationId: 'loc_1',
  delta: 0, reason: 'received', createdAt: NOW.toISOString(), ...over,
});

describe('inventory is a ledger, not a counter', () => {
  it('folds movements into a level', () => {
    const levels = levelsFrom([
      movement({ delta: 10, reason: 'received' }),
      movement({ delta: -3, reason: 'sold' }),
      movement({ delta: 1, reason: 'returned' }),
    ]);
    expect(availableFor(levels, 'var_1')).toBe(8);
  });

  it('keeps reservations separate from stock physically present', () => {
    // A reserved unit is still in the building. Decrementing on-hand for it
    // makes every stock take disagree while a cart is open.
    const levels = levelsFrom([
      movement({ delta: 10, reason: 'received' }),
      movement({ delta: 4, reason: 'reserved' }),
    ]);
    const level = levels.get(levelKey('var_1', 'loc_1'))!;
    expect(level.onHand).toBe(10);
    expect(level.reserved).toBe(4);
    expect(level.available).toBe(6);
  });

  it('sums availability across locations when none is named', () => {
    const levels = levelsFrom([
      movement({ delta: 4, locationId: 'loc_1' }),
      movement({ delta: 6, locationId: 'loc_2' }),
    ]);
    expect(availableFor(levels, 'var_1')).toBe(10);
    expect(availableFor(levels, 'var_1', 'loc_2')).toBe(6);
  });

  it('reports what can be part-filled rather than failing the whole basket', () => {
    const levels = levelsFrom([movement({ delta: 2 })]);
    const variants = new Map([['var_1', { trackInventory: true, allowBackorder: false }]]);
    const decision = checkStock([{ variantId: 'var_1', quantity: 5, locationId: 'loc_1' }], variants, levels);
    expect(decision.ok).toBe(false);
    expect(decision.lines[0]).toMatchObject({ requested: 5, fulfillable: 2, reason: 'partial' });
  });

  it('lets untracked and backorder variants through', () => {
    const levels = levelsFrom([]);
    const variants = new Map([
      ['a', { trackInventory: false, allowBackorder: false }],
      ['b', { trackInventory: true, allowBackorder: true }],
    ]);
    const decision = checkStock([
      { variantId: 'a', quantity: 3, locationId: 'loc_1' },
      { variantId: 'b', quantity: 3, locationId: 'loc_1' },
    ], variants, levels);
    expect(decision.ok).toBe(true);
  });

  it('releases expired reservations so an abandoned cart stops holding stock', () => {
    const reservation: Reservation = {
      id: 'res_1', siteId: SITE, cartId: 'cart_1',
      lines: [{ variantId: 'var_1', quantity: 2, locationId: 'loc_1' }],
      createdAt: '2026-03-01T09:00:00.000Z',
      expiresAt: '2026-03-01T09:15:00.000Z',
    };
    const { movements, expired } = expireReservations([reservation], NOW, () => makeId('inv'));
    expect(expired).toHaveLength(1);

    const levels = levelsFrom([
      movement({ delta: 10, reason: 'received' }),
      movement({ delta: 2, reason: 'reserved' }),
      ...movements.map((m) => ({ ...m })),
    ]);
    expect(availableFor(levels, 'var_1')).toBe(10);
  });

  it('does not release a reservation that is still live', () => {
    const reservation: Reservation = {
      id: 'res_2', siteId: SITE, cartId: 'cart_2',
      lines: [{ variantId: 'var_1', quantity: 1, locationId: 'loc_1' }],
      createdAt: NOW.toISOString(),
      expiresAt: '2026-03-01T10:30:00.000Z',
    };
    expect(expireReservations([reservation], NOW, () => makeId('inv')).expired).toHaveLength(0);
  });

  it('lists low stock worst first', () => {
    const levels = levelsFrom([
      movement({ variantId: 'a', delta: 1 }),
      movement({ variantId: 'b', delta: 9 }),
      movement({ variantId: 'c', delta: 0 }),
    ]);
    const low = lowStock(levels, new Map([['a', 3], ['b', 3], ['c', 3]]));
    expect(low.map((l) => l.variantId)).toEqual(['c', 'a']);
  });
});

/* ------------------------------------------------------------------ */

function orderFixture(over: { quantity?: number; shipping?: number } = {}): Order {
  const cart = priceCart({
    currency: CAD,
    lines: [{ id: 'l1', unitPrice: c(2500), quantity: over.quantity ?? 2 }],
    shipping: c(over.shipping ?? 0),
    taxRates: [{ id: 'gst', label: 'GST', rate: 0.05 }],
  });
  const r = createOrder({
    siteId: SITE, number: '#1001', email: 'buyer@example.com', cart,
    lineDetails: new Map([['l1', { variantId: 'var_1', productId: 'prd_1', title: 'Ridge cap', requiresShipping: true }]]),
    shippingAddress: { line1: '1 Main St', city: 'Charlottetown', countryCode: 'CA' },
    now: NOW, makeId,
  });
  if (!r.ok) throw r.error;
  return r.value;
}

const pay = (over: Record<string, unknown> = {}) => ({
  amount: c(5250), provider: 'stripe', idempotencyKey: makeId('key'), now: NOW, makeId, ...over,
});

describe('orders', () => {
  it('freezes catalog details at capture', () => {
    // The merchant renaming a product must not change what the customer
    // already agreed to buy.
    const order = orderFixture();
    expect(order.lines[0]!.title).toBe('Ridge cap');
    expect(order.total.amount).toBe(5250);
    assertOrderConsistent(order);
  });

  it('requires a delivery address when something must ship', () => {
    const cart = priceCart({ currency: CAD, lines: [{ id: 'l1', unitPrice: c(100), quantity: 1 }] });
    const r = createOrder({
      siteId: SITE, number: '#1', email: 'a@b.co', cart,
      lineDetails: new Map([['l1', { variantId: 'v', productId: 'p', title: 'T', requiresShipping: true }]]),
      now: NOW, makeId,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an unusable email rather than losing the confirmation', () => {
    const cart = priceCart({ currency: CAD, lines: [{ id: 'l1', unitPrice: c(100), quantity: 1 }] });
    const r = createOrder({
      siteId: SITE, number: '#1', email: 'not-an-email', cart,
      lineDetails: new Map([['l1', { variantId: 'v', productId: 'p', title: 'T', requiresShipping: false }]]),
      now: NOW, makeId,
    });
    expect(r.ok).toBe(false);
  });
});

describe('payment', () => {
  it('captures and marks the order paid', () => {
    const order = orderFixture();
    const r = capturePayment(order, pay());
    expect(r.ok).toBe(true);
    const paid = (r as { value: Order }).value;
    expect(paid.paymentStatus).toBe('paid');
    expect(outstandingBalance(paid).amount).toBe(0);
    assertOrderConsistent(paid);
  });

  it('is idempotent, so a retried webhook does not take the money twice', () => {
    const order = orderFixture();
    const key = 'evt_stripe_1';
    const once = capturePayment(order, pay({ idempotencyKey: key }));
    const twice = capturePayment((once as { value: Order }).value, pay({ idempotencyKey: key }));
    const final = (twice as { value: Order }).value;
    expect(final.payments).toHaveLength(1);
    expect(capturedTotal(final).amount).toBe(5250);
  });

  it('refuses to capture more than the order total', () => {
    const order = orderFixture();
    const r = capturePayment(order, pay({ amount: c(999999) }));
    expect(r.ok).toBe(false);
  });

  it('leaves a part payment pending', () => {
    const order = orderFixture();
    const r = capturePayment(order, pay({ amount: c(1000) }));
    const partial = (r as { value: Order }).value;
    expect(partial.paymentStatus).toBe('pending');
    expect(outstandingBalance(partial).amount).toBe(4250);
  });

  it('refuses payment on a cancelled order', () => {
    const order = orderFixture();
    const cancelled = (cancelOrder(order, { reason: 'duplicate', now: NOW, makeId }) as { value: Order }).value;
    expect(capturePayment(cancelled, pay()).ok).toBe(false);
  });
});

describe('refunds', () => {
  const paid = () => (capturePayment(orderFixture(), pay()) as { value: Order }).value;

  it('cannot exceed what was captured, however it is sliced', () => {
    let order = paid();
    order = (refundPayment(order, pay({ amount: c(3000) })) as { value: Order }).value;
    expect(order.paymentStatus).toBe('partially_refunded');

    const over = refundPayment(order, pay({ amount: c(3000) }));
    expect(over.ok).toBe(false);
    expect(String((over as { error: Error }).error.message)).toMatch(/remains refundable/);

    order = (refundPayment(order, pay({ amount: c(2250) })) as { value: Order }).value;
    expect(order.paymentStatus).toBe('refunded');
    expect(netReceived(order).amount).toBe(0);
    assertOrderConsistent(order);
  });

  it('caps per line as well as in total', () => {
    // A total-only check lets a merchant refund three of two units so long as
    // the money adds up, which corrupts returns and stock.
    const order = paid();
    const r = refundPayment(order, pay({ amount: c(100), lines: [{ lineId: 'l1', quantity: 3 }] }));
    expect(r.ok).toBe(false);
    expect(String((r as { error: Error }).error.message)).toMatch(/only 2 of 2 remain/);
  });

  it('tracks refunded quantity per line for returns', () => {
    const order = paid();
    const after = (refundPayment(order, pay({ amount: c(2625), lines: [{ lineId: 'l1', quantity: 1 }] })) as { value: Order }).value;
    expect(after.lines[0]!.quantityRefunded).toBe(1);
    expect(refundedTotal(after).amount).toBe(2625);
    assertOrderConsistent(after);
  });

  it('is idempotent on its key', () => {
    const order = paid();
    const key = 'refund_evt_1';
    const once = (refundPayment(order, pay({ amount: c(1000), idempotencyKey: key })) as { value: Order }).value;
    const twice = (refundPayment(once, pay({ amount: c(1000), idempotencyKey: key })) as { value: Order }).value;
    expect(refundedTotal(twice).amount).toBe(1000);
  });

  it('produces restock movements for what came back', () => {
    const order = paid();
    const movements = restockMovementsFor(order, [{ lineId: 'l1', quantity: 2 }], 'loc_1', NOW, () => makeId('inv'));
    expect(movements[0]).toMatchObject({ variantId: 'var_1', delta: 2, reason: 'returned' });
  });
});

describe('fulfilment', () => {
  it('moves through partial to fulfilled', () => {
    let order = orderFixture({ quantity: 3 });
    order = (fulfil(order, { lines: [{ lineId: 'l1', quantity: 1 }], now: NOW, makeId }) as { value: Order }).value;
    expect(order.fulfilmentStatus).toBe('partially_fulfilled');
    order = (fulfil(order, { lines: [{ lineId: 'l1', quantity: 2 }], carrier: 'Purolator', trackingNumber: 'PU1', now: NOW, makeId }) as { value: Order }).value;
    expect(order.fulfilmentStatus).toBe('fulfilled');
    assertOrderConsistent(order);
  });

  it('refuses to ship more than was bought', () => {
    const order = orderFixture({ quantity: 2 });
    expect(fulfil(order, { lines: [{ lineId: 'l1', quantity: 3 }], now: NOW, makeId }).ok).toBe(false);
  });

  it('refuses to ship units that were already refunded', () => {
    // Refund-then-ship would send the goods away for free.
    let order = (capturePayment(orderFixture({ quantity: 2 }), pay()) as { value: Order }).value;
    order = (refundPayment(order, pay({ amount: c(2625), lines: [{ lineId: 'l1', quantity: 1 }] })) as { value: Order }).value;
    expect(fulfil(order, { lines: [{ lineId: 'l1', quantity: 2 }], now: NOW, makeId }).ok).toBe(false);
    const one = fulfil(order, { lines: [{ lineId: 'l1', quantity: 1 }], now: NOW, makeId });
    expect(one.ok).toBe(true);
    // One bought, one refunded, one shipped — nothing is still owed.
    expect((one as { value: Order }).value.fulfilmentStatus).toBe('fulfilled');
  });

  it('refuses to cancel an order that has already shipped', () => {
    const order = (fulfil(orderFixture(), { lines: [{ lineId: 'l1', quantity: 1 }], now: NOW, makeId }) as { value: Order }).value;
    const r = cancelOrder(order, { reason: 'changed mind', now: NOW, makeId });
    expect(r.ok).toBe(false);
    expect(String((r as { error: Error }).error.message)).toMatch(/already shipped/);
  });

  it('cancelling twice is a no-op rather than an error', () => {
    const order = orderFixture();
    const once = (cancelOrder(order, { reason: 'x', now: NOW, makeId }) as { value: Order }).value;
    const twice = cancelOrder(once, { reason: 'y', now: NOW, makeId });
    expect(twice.ok).toBe(true);
    expect((twice as { value: Order }).value.cancelReason).toBe('x');
  });
});

describe('order consistency holds under a randomised sweep', () => {
  it('never lets captures, refunds or shipments exceed their bounds', () => {
    for (let seed = 1; seed <= 120; seed++) {
      let order = orderFixture({ quantity: (seed % 4) + 1, shipping: seed % 500 });
      const total = order.total.amount;
      const chunk = Math.max(1, Math.floor(total / ((seed % 3) + 1)));

      for (let i = 0; i < 4; i++) {
        const r = capturePayment(order, pay({ amount: c(chunk) }));
        if (r.ok) order = r.value;
      }
      expect(capturedTotal(order).amount).toBeLessThanOrEqual(total);

      for (let i = 0; i < 4; i++) {
        const r = refundPayment(order, pay({ amount: c(chunk) }));
        if (r.ok) order = r.value;
      }
      for (let i = 0; i < 4; i++) {
        const r = fulfil(order, { lines: [{ lineId: 'l1', quantity: 1 }], now: NOW, makeId });
        if (r.ok) order = r.value;
      }

      expect(() => assertOrderConsistent(order), `seed ${seed}`).not.toThrow();
      expect(refundedTotal(order).amount).toBeLessThanOrEqual(capturedTotal(order).amount);
    }
  });
});
