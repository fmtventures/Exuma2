/**
 * Orders.
 *
 * An order is an immutable record of what was agreed plus an append-only log
 * of what has happened to it since. Payment, fulfilment and refunds are
 * tracked as separate state machines because they genuinely move
 * independently: an order can be paid and unfulfilled, fulfilled and
 * unpaid, or partially both.
 *
 * Three properties this module exists to guarantee:
 *
 *  1. **Prices are frozen at capture.** An order stores the priced lines, not
 *     references to a catalog that will change. A merchant editing a price
 *     must never alter what a customer already agreed to pay.
 *  2. **Refunds cannot exceed what was captured**, per line or in total, no
 *     matter how the refunds are sliced or in what order they arrive.
 *  3. **Every mutation is idempotent under a key.** Payment webhooks retry;
 *     a retried capture must not take the money twice.
 */

import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { SiteId, UserId } from '../core/ids.ts';
import { add, isNegative, money, subtract, sum, zero, type CurrencyCode, type Money } from './money.ts';
import type { PricedCart } from './pricing.ts';

export type PaymentStatus =
  | 'pending' | 'authorized' | 'paid' | 'partially_refunded' | 'refunded' | 'voided' | 'failed';

export type FulfilmentStatus =
  | 'unfulfilled' | 'partially_fulfilled' | 'fulfilled' | 'returned' | 'cancelled';

export interface OrderLine {
  id: string;
  variantId: string;
  productId: string;
  /** Copied at capture — the catalog may rename or delete the product later. */
  title: string;
  sku?: string;
  quantity: number;
  unitPrice: Money;
  subtotal: Money;
  discountTotal: Money;
  net: Money;
  taxTotal: Money;
  total: Money;
  quantityFulfilled: number;
  quantityRefunded: number;
  requiresShipping: boolean;
}

export interface Address {
  name?: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  countryCode: string;
  phone?: string;
}

export interface Payment {
  id: string;
  kind: 'authorization' | 'capture' | 'refund' | 'void';
  amount: Money;
  provider: string;
  providerReference?: string;
  /** Retried webhooks carry the same key; the second one is a no-op. */
  idempotencyKey: string;
  createdAt: string;
  note?: string;
}

export interface Fulfilment {
  id: string;
  lines: { lineId: string; quantity: number }[];
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shippedAt?: string;
  deliveredAt?: string;
  createdAt: string;
}

export interface OrderEvent {
  id: string;
  at: string;
  kind: string;
  message: string;
  actorId?: UserId;
  /** Customer-visible events appear in the order status page. */
  customerVisible: boolean;
}

export interface Order {
  id: string;
  siteId: SiteId;
  /** Human-facing, per-site sequence: #1001. */
  number: string;
  currency: CurrencyCode;
  email: string;
  customerId?: string;
  lines: OrderLine[];
  subtotal: Money;
  discountTotal: Money;
  shipping: Money;
  taxTotal: Money;
  total: Money;
  billingAddress?: Address;
  shippingAddress?: Address;
  paymentStatus: PaymentStatus;
  fulfilmentStatus: FulfilmentStatus;
  payments: Payment[];
  fulfilments: Fulfilment[];
  events: OrderEvent[];
  note?: string;
  tags: string[];
  cancelledAt?: string;
  cancelReason?: string;
  placedAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

export interface CreateOrderInput {
  siteId: SiteId;
  number: string;
  email: string;
  customerId?: string;
  cart: PricedCart;
  /** Catalog details resolved at capture time, keyed by priced-line id. */
  lineDetails: Map<string, { variantId: string; productId: string; title: string; sku?: string; requiresShipping: boolean }>;
  billingAddress?: Address;
  shippingAddress?: Address;
  now: Date;
  makeId: (prefix: string) => string;
}

export function createOrder(input: CreateOrderInput): Result<Order> {
  const { cart, now } = input;
  if (cart.lines.length === 0) {
    return fail(err('VALIDATION_FAILED', 'an order needs at least one line'));
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) {
    return fail(err('VALIDATION_FAILED', 'a valid email is required to send an order confirmation'));
  }

  const lines: OrderLine[] = [];
  for (const priced of cart.lines) {
    const detail = input.lineDetails.get(priced.id);
    if (!detail) {
      return fail(err('VALIDATION_FAILED', `no catalog detail supplied for line ${priced.id}`));
    }
    lines.push({
      id: priced.id,
      variantId: detail.variantId,
      productId: detail.productId,
      title: detail.title,
      ...(detail.sku ? { sku: detail.sku } : {}),
      quantity: priced.quantity,
      unitPrice: priced.unitPrice,
      subtotal: priced.subtotal,
      discountTotal: priced.discountTotal,
      net: priced.net,
      taxTotal: priced.taxTotal,
      total: priced.total,
      quantityFulfilled: 0,
      quantityRefunded: 0,
      requiresShipping: detail.requiresShipping,
    });
  }

  if (lines.some((l) => l.requiresShipping) && !input.shippingAddress) {
    return fail(err('VALIDATION_FAILED', 'this order contains shipped items and needs a delivery address'));
  }

  return ok({
    id: input.makeId('ord'),
    siteId: input.siteId,
    number: input.number,
    currency: cart.currency,
    email: input.email,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    lines,
    subtotal: cart.subtotal,
    discountTotal: cart.discountTotal,
    shipping: cart.shipping,
    taxTotal: cart.taxTotal,
    total: cart.total,
    ...(input.billingAddress ? { billingAddress: input.billingAddress } : {}),
    ...(input.shippingAddress ? { shippingAddress: input.shippingAddress } : {}),
    paymentStatus: 'pending',
    fulfilmentStatus: 'unfulfilled',
    payments: [],
    fulfilments: [],
    events: [{
      id: input.makeId('evt'),
      at: now.toISOString(),
      kind: 'placed',
      message: `Order ${input.number} placed`,
      customerVisible: true,
    }],
    tags: [],
    placedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
}

/* ------------------------------------------------------------------ */
/* Money already taken and given back                                  */
/* ------------------------------------------------------------------ */

export function capturedTotal(order: Order): Money {
  return sum(order.payments.filter((p) => p.kind === 'capture').map((p) => p.amount), order.currency);
}

export function refundedTotal(order: Order): Money {
  return sum(order.payments.filter((p) => p.kind === 'refund').map((p) => p.amount), order.currency);
}

export function authorizedTotal(order: Order): Money {
  return sum(order.payments.filter((p) => p.kind === 'authorization').map((p) => p.amount), order.currency);
}

/** Captured minus refunded — what the merchant is actually holding. */
export function netReceived(order: Order): Money {
  return subtract(capturedTotal(order), refundedTotal(order));
}

export function outstandingBalance(order: Order): Money {
  return subtract(order.total, netReceived(order));
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

export interface PaymentInput {
  amount: Money;
  provider: string;
  providerReference?: string;
  idempotencyKey: string;
  now: Date;
  makeId: (prefix: string) => string;
  actorId?: UserId;
  note?: string;
}

/**
 * Record a capture.
 *
 * Idempotent on the key: a retried webhook returns the unchanged order rather
 * than taking the money twice. Providers retry aggressively and a duplicate
 * capture is the worst bug this module could have.
 */
export function capturePayment(order: Order, input: PaymentInput): Result<Order> {
  const existing = order.payments.find((p) => p.idempotencyKey === input.idempotencyKey);
  if (existing) return ok(order);

  if (order.cancelledAt) {
    return fail(err('CONFLICT', 'this order was cancelled and cannot take a payment'));
  }
  if (input.amount.currency !== order.currency) {
    return fail(err('VALIDATION_FAILED', `payment is in ${input.amount.currency}, the order is in ${order.currency}`));
  }
  if (input.amount.amount <= 0) {
    return fail(err('VALIDATION_FAILED', 'a capture must be a positive amount'));
  }

  const after = add(capturedTotal(order), input.amount);
  if (after.amount > order.total.amount) {
    return fail(err('VALIDATION_FAILED',
      `capturing ${input.amount.amount} would take ${after.amount} against an order total of ${order.total.amount}`));
  }

  const payment: Payment = {
    id: input.makeId('pay'),
    kind: 'capture',
    amount: input.amount,
    provider: input.provider,
    ...(input.providerReference ? { providerReference: input.providerReference } : {}),
    idempotencyKey: input.idempotencyKey,
    createdAt: input.now.toISOString(),
    ...(input.note ? { note: input.note } : {}),
  };

  const payments = [...order.payments, payment];
  const next: Order = {
    ...order,
    payments,
    paymentStatus: after.amount >= order.total.amount ? 'paid' : 'pending',
    updatedAt: input.now.toISOString(),
  };
  return ok(appendEvent(next, {
    id: input.makeId('evt'),
    at: input.now.toISOString(),
    kind: 'payment_captured',
    message: `Payment of ${input.amount.amount} captured via ${input.provider}`,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    customerVisible: true,
  }));
}

export interface RefundInput extends PaymentInput {
  /** Per-line refunds keep line-level totals honest for reporting and returns. */
  lines?: { lineId: string; quantity: number }[];
  restock?: boolean;
  reason?: string;
}

/**
 * Record a refund.
 *
 * Capped against what was actually captured and, when lines are given, against
 * what each line still has left. Both caps matter: a total-only check lets a
 * merchant refund three of two units on one line as long as the money adds up,
 * which corrupts returns and stock.
 */
export function refundPayment(order: Order, input: RefundInput): Result<Order> {
  const existing = order.payments.find((p) => p.idempotencyKey === input.idempotencyKey);
  if (existing) return ok(order);

  if (input.amount.currency !== order.currency) {
    return fail(err('VALIDATION_FAILED', `refund is in ${input.amount.currency}, the order is in ${order.currency}`));
  }
  if (input.amount.amount <= 0) {
    return fail(err('VALIDATION_FAILED', 'a refund must be a positive amount'));
  }

  const alreadyRefunded = refundedTotal(order);
  const refundable = subtract(capturedTotal(order), alreadyRefunded);
  if (input.amount.amount > refundable.amount) {
    return fail(err('VALIDATION_FAILED',
      `cannot refund ${input.amount.amount}; only ${refundable.amount} of this order remains refundable`));
  }

  let lines = order.lines;
  if (input.lines?.length) {
    const byId = new Map(order.lines.map((l) => [l.id, l]));
    for (const request of input.lines) {
      const line = byId.get(request.lineId);
      if (!line) return fail(err('NOT_FOUND', `line ${request.lineId} is not on this order`));
      if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
        return fail(err('VALIDATION_FAILED', `refund quantity for ${request.lineId} must be a positive whole number`));
      }
      const remaining = line.quantity - line.quantityRefunded;
      if (request.quantity > remaining) {
        return fail(err('VALIDATION_FAILED',
          `cannot refund ${request.quantity} of "${line.title}"; only ${remaining} of ${line.quantity} remain`));
      }
    }
    const deltas = new Map(input.lines.map((l) => [l.lineId, l.quantity]));
    lines = order.lines.map((l) => {
      const delta = deltas.get(l.id);
      return delta ? { ...l, quantityRefunded: l.quantityRefunded + delta } : l;
    });
  }

  const payment: Payment = {
    id: input.makeId('pay'),
    kind: 'refund',
    amount: input.amount,
    provider: input.provider,
    ...(input.providerReference ? { providerReference: input.providerReference } : {}),
    idempotencyKey: input.idempotencyKey,
    createdAt: input.now.toISOString(),
    ...(input.reason ? { note: input.reason } : {}),
  };

  const totalRefunded = add(alreadyRefunded, input.amount);
  const next: Order = {
    ...order,
    lines,
    payments: [...order.payments, payment],
    paymentStatus: totalRefunded.amount >= capturedTotal(order).amount ? 'refunded' : 'partially_refunded',
    updatedAt: input.now.toISOString(),
  };
  return ok(appendEvent(next, {
    id: input.makeId('evt'),
    at: input.now.toISOString(),
    kind: 'payment_refunded',
    message: `Refund of ${input.amount.amount}${input.reason ? ` — ${input.reason}` : ''}`,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    customerVisible: true,
  }));
}

export interface FulfilInput {
  lines: { lineId: string; quantity: number }[];
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  now: Date;
  makeId: (prefix: string) => string;
  actorId?: UserId;
}

export function fulfil(order: Order, input: FulfilInput): Result<Order> {
  if (order.cancelledAt) {
    return fail(err('CONFLICT', 'this order was cancelled and cannot be fulfilled'));
  }
  if (input.lines.length === 0) {
    return fail(err('VALIDATION_FAILED', 'a fulfilment needs at least one line'));
  }

  const byId = new Map(order.lines.map((l) => [l.id, l]));
  for (const request of input.lines) {
    const line = byId.get(request.lineId);
    if (!line) return fail(err('NOT_FOUND', `line ${request.lineId} is not on this order`));
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      return fail(err('VALIDATION_FAILED', `fulfilment quantity for ${request.lineId} must be a positive whole number`));
    }
    // Refunded units are no longer owed to the customer, so they cannot be
    // shipped — otherwise a refund-then-ship sends goods away for free.
    const shippable = line.quantity - line.quantityFulfilled - line.quantityRefunded;
    if (request.quantity > shippable) {
      return fail(err('VALIDATION_FAILED',
        `cannot fulfil ${request.quantity} of "${line.title}"; only ${shippable} remain unshipped`));
    }
  }

  const deltas = new Map(input.lines.map((l) => [l.lineId, l.quantity]));
  const lines = order.lines.map((l) => {
    const delta = deltas.get(l.id);
    return delta ? { ...l, quantityFulfilled: l.quantityFulfilled + delta } : l;
  });

  const fulfilment: Fulfilment = {
    id: input.makeId('ful'),
    lines: input.lines,
    ...(input.carrier ? { carrier: input.carrier } : {}),
    ...(input.trackingNumber ? { trackingNumber: input.trackingNumber } : {}),
    ...(input.trackingUrl ? { trackingUrl: input.trackingUrl } : {}),
    createdAt: input.now.toISOString(),
    shippedAt: input.now.toISOString(),
  };

  const next: Order = {
    ...order,
    lines,
    fulfilments: [...order.fulfilments, fulfilment],
    fulfilmentStatus: fulfilmentStatusFor(lines),
    updatedAt: input.now.toISOString(),
  };
  return ok(appendEvent(next, {
    id: input.makeId('evt'),
    at: input.now.toISOString(),
    kind: 'fulfilled',
    message: input.trackingNumber
      ? `Shipped via ${input.carrier ?? 'carrier'} — ${input.trackingNumber}`
      : 'Items marked as fulfilled',
    ...(input.actorId ? { actorId: input.actorId } : {}),
    customerVisible: true,
  }));
}

export function fulfilmentStatusFor(lines: OrderLine[]): FulfilmentStatus {
  // Refunded units are excluded from what is owed, so an order that is part
  // refunded and part shipped still reads as fully fulfilled.
  const owed = lines.reduce((n, l) => n + (l.quantity - l.quantityRefunded), 0);
  const shipped = lines.reduce((n, l) => n + l.quantityFulfilled, 0);
  if (owed === 0) return 'returned';
  if (shipped === 0) return 'unfulfilled';
  return shipped >= owed ? 'fulfilled' : 'partially_fulfilled';
}

export interface CancelInput {
  reason: string;
  now: Date;
  makeId: (prefix: string) => string;
  actorId?: UserId;
}

export function cancelOrder(order: Order, input: CancelInput): Result<Order> {
  if (order.cancelledAt) return ok(order);
  if (order.fulfilments.length > 0) {
    return fail(err('CONFLICT',
      'this order has already shipped; refund or process a return rather than cancelling'));
  }
  const next: Order = {
    ...order,
    cancelledAt: input.now.toISOString(),
    cancelReason: input.reason,
    fulfilmentStatus: 'cancelled',
    updatedAt: input.now.toISOString(),
  };
  return ok(appendEvent(next, {
    id: input.makeId('evt'),
    at: input.now.toISOString(),
    kind: 'cancelled',
    message: `Order cancelled — ${input.reason}`,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    customerVisible: true,
  }));
}

function appendEvent(order: Order, event: OrderEvent): Order {
  return { ...order, events: [...order.events, event] };
}

/**
 * Check an order's internal consistency.
 *
 * Called after every transition in tests and before persisting in the API. An
 * order that has captured more than its total, refunded more than it captured,
 * or shipped more units than were bought is a data-integrity failure that
 * should stop the write, not be discovered in a month-end reconciliation.
 */
export function assertOrderConsistent(order: Order): void {
  const captured = capturedTotal(order);
  const refunded = refundedTotal(order);
  if (captured.amount > order.total.amount) {
    throw err('INTERNAL', `order ${order.number} has captured more than its total`);
  }
  if (refunded.amount > captured.amount) {
    throw err('INTERNAL', `order ${order.number} has refunded more than it captured`);
  }
  if (isNegative(netReceived(order))) {
    throw err('INTERNAL', `order ${order.number} has a negative net received`);
  }
  for (const line of order.lines) {
    if (line.quantityFulfilled + line.quantityRefunded > line.quantity) {
      throw err('INTERNAL',
        `order ${order.number} line "${line.title}" has more units fulfilled and refunded than were bought`);
    }
  }
  const lineTotals = sum(order.lines.map((l) => l.total), order.currency);
  const expected = add(lineTotals, order.shipping);
  if (expected.amount !== order.total.amount) {
    throw err('INTERNAL', `order ${order.number} total does not equal its lines plus shipping`);
  }
}

/** Stock to put back when a refund restocks. */
export function restockMovementsFor(
  order: Order,
  refundLines: { lineId: string; quantity: number }[],
  locationId: string,
  now: Date,
  makeId: () => string,
): { variantId: string; locationId: string; delta: number; reason: 'returned'; referenceId: string; createdAt: string; id: string; siteId: SiteId }[] {
  const byId = new Map(order.lines.map((l) => [l.id, l]));
  return refundLines.flatMap((r) => {
    const line = byId.get(r.lineId);
    if (!line) return [];
    return [{
      id: makeId(),
      siteId: order.siteId,
      variantId: line.variantId,
      locationId,
      delta: r.quantity,
      reason: 'returned' as const,
      referenceId: order.id,
      createdAt: now.toISOString(),
    }];
  });
}

export const orderZero = (order: Order): Money => zero(order.currency);
export const orderMoney = (order: Order, amount: number): Money => money(amount, order.currency);
