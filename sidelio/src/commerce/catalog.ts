/**
 * Product catalog and inventory.
 *
 * A product is a listing; a variant is the thing that actually has a price, a
 * SKU and stock. Even a product with no options has exactly one variant, so
 * every downstream module — cart, order, inventory, reporting — deals with a
 * single shape and never has to ask "does this one have variants?".
 *
 * Inventory is a ledger of movements rather than a mutable counter. A counter
 * cannot answer "why is this at 3?", cannot be reconciled against a stock
 * take, and loses writes when two orders decrement it concurrently. Movements
 * are append-only, and the level is their sum.
 */

import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { SiteId } from '../core/ids.ts';
import type { Money } from './money.ts';

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export interface ProductOption {
  /** "Size", "Colour". */
  name: string;
  /** Ordered — the order is the display order in the storefront. */
  values: string[];
}

export interface Variant {
  id: string;
  productId: string;
  /** Option values in the same order as the product's options. */
  optionValues: string[];
  sku?: string;
  barcode?: string;
  price: Money;
  /** Shown struck through when higher than `price`. */
  compareAtPrice?: Money;
  /** What the merchant paid; used for margin reporting, never shown publicly. */
  costPrice?: Money;
  taxClass?: string;
  requiresShipping: boolean;
  weightGrams?: number;
  imageAssetId?: string;
  /** false lets the variant oversell; true blocks at zero. */
  trackInventory: boolean;
  /** Sell past zero even while tracking, for made-to-order goods. */
  allowBackorder: boolean;
  position: number;
  archivedAt?: string;
}

export interface Product {
  id: string;
  siteId: SiteId;
  title: string;
  handle: string;
  descriptionHtml?: string;
  status: 'draft' | 'active' | 'archived';
  productType?: string;
  vendor?: string;
  tags: string[];
  options: ProductOption[];
  variants: Variant[];
  imageAssetIds: string[];
  collectionIds: string[];
  seo?: { metaTitle?: string; metaDescription?: string };
  publishedAt?: string;
  updatedAt: string;
}

/**
 * Validate a product's option/variant matrix.
 *
 * The invariants here are the ones that produce unsellable listings if they
 * drift: a variant whose option count no longer matches the product's, two
 * variants claiming the same combination, or a duplicate SKU that makes stock
 * ambiguous.
 */
export function validateProduct(product: Product): Result<Product> {
  if (product.title.trim() === '') {
    return fail(err('VALIDATION_FAILED', 'a product needs a title'));
  }
  if (product.variants.length === 0) {
    return fail(err('VALIDATION_FAILED', 'a product needs at least one variant'));
  }
  for (const option of product.options) {
    if (option.values.length === 0) {
      return fail(err('VALIDATION_FAILED', `option "${option.name}" has no values`));
    }
    if (new Set(option.values).size !== option.values.length) {
      return fail(err('VALIDATION_FAILED', `option "${option.name}" repeats a value`));
    }
  }

  const seenCombos = new Set<string>();
  const seenSkus = new Set<string>();
  const currency = product.variants[0]?.price.currency;

  for (const variant of product.variants) {
    if (variant.optionValues.length !== product.options.length) {
      return fail(err('VALIDATION_FAILED',
        `variant ${variant.id} has ${variant.optionValues.length} option values but the product defines ${product.options.length}`));
    }
    for (const [i, value] of variant.optionValues.entries()) {
      const option = product.options[i];
      if (option && !option.values.includes(value)) {
        return fail(err('VALIDATION_FAILED', `variant ${variant.id} uses "${value}", which is not a value of "${option.name}"`));
      }
    }
    const combo = variant.optionValues.join(' ');
    if (seenCombos.has(combo)) {
      return fail(err('CONFLICT', `two variants share the combination ${variant.optionValues.join(' / ') || 'default'}`));
    }
    seenCombos.add(combo);

    if (variant.sku) {
      const sku = variant.sku.trim().toLowerCase();
      if (seenSkus.has(sku)) {
        return fail(err('CONFLICT', `SKU "${variant.sku}" is used by more than one variant`));
      }
      seenSkus.add(sku);
    }
    if (variant.price.amount < 0) {
      return fail(err('VALIDATION_FAILED', `variant ${variant.id} has a negative price`));
    }
    // A cart cannot be priced across currencies, so a product must not mix them.
    if (variant.price.currency !== currency) {
      return fail(err('VALIDATION_FAILED', `variant ${variant.id} is priced in ${variant.price.currency}, the product uses ${currency}`));
    }
    if (variant.compareAtPrice && variant.compareAtPrice.amount <= variant.price.amount) {
      // A "was" price that is not higher is a false saving claim, which is a
      // regulated statement in most of the markets this ships to.
      return fail(err('VALIDATION_FAILED',
        `variant ${variant.id} has a compare-at price that is not above its price, which would advertise a saving that does not exist`));
    }
  }

  return ok(product);
}

/** Every combination the options imply, in stable display order. */
export function optionMatrix(options: ProductOption[]): string[][] {
  return options.reduce<string[][]>(
    (acc, option) => acc.flatMap((row) => option.values.map((v) => [...row, v])),
    [[]],
  );
}

/** Combinations the product declares but has no variant for. */
export function missingVariants(product: Product): string[][] {
  const have = new Set(product.variants.map((v) => v.optionValues.join(' ')));
  return optionMatrix(product.options).filter((combo) => !have.has(combo.join(' ')));
}

export function variantTitle(product: Product, variant: Variant): string {
  return variant.optionValues.length > 0
    ? `${product.title} — ${variant.optionValues.join(' / ')}`
    : product.title;
}

/** Lowest price across sellable variants — what a listing card shows. */
export function fromPrice(product: Product): Money | undefined {
  const sellable = product.variants.filter((v) => !v.archivedAt);
  if (sellable.length === 0) return undefined;
  return sellable.reduce((min, v) => (v.price.amount < min.amount ? v.price : min), sellable[0]!.price);
}

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

export type MovementReason =
  | 'stock_take' | 'received' | 'sold' | 'returned'
  | 'damaged' | 'correction' | 'reserved' | 'reservation_released';

export interface InventoryMovement {
  id: string;
  siteId: SiteId;
  variantId: string;
  locationId: string;
  /** Signed. Negative removes stock. */
  delta: number;
  reason: MovementReason;
  /** Order, stock take or reservation this movement belongs to. */
  referenceId?: string;
  note?: string;
  actorId?: string;
  createdAt: string;
}

export interface InventoryLevel {
  variantId: string;
  locationId: string;
  /** Physically present. */
  onHand: number;
  /** Committed to unpaid carts and unfulfilled orders. */
  reserved: number;
  /** onHand − reserved. What may still be sold. */
  available: number;
}

/**
 * Fold movements into levels.
 *
 * Reservations are tracked as their own signed quantity rather than by
 * decrementing on-hand, because a reserved unit is still physically in the
 * building. Conflating the two makes a stock take disagree with the system
 * every time there is an unpaid cart.
 */
/**
 * Key for the level map.
 *
 * Exported so nothing hand-builds the string. Two call sites once disagreed on
 * the separator, and the lookup silently returned undefined rather than
 * failing — a stock level that reads as "no record" instead of "six in Halifax"
 * is indistinguishable from out of stock.
 */
export function levelKey(variantId: string, locationId: string): string {
  // Joined rather than interpolated: a literal separator inside a template
  // literal is exactly where the stray control character got in.
  return [variantId, locationId].join('/');
}

export function levelsFrom(movements: InventoryMovement[]): Map<string, InventoryLevel> {
  const levels = new Map<string, InventoryLevel>();
  for (const m of movements) {
    const key = levelKey(m.variantId, m.locationId);
    const level = levels.get(key) ?? {
      variantId: m.variantId, locationId: m.locationId, onHand: 0, reserved: 0, available: 0,
    };
    if (m.reason === 'reserved') level.reserved += m.delta;
    else if (m.reason === 'reservation_released') level.reserved -= m.delta;
    else level.onHand += m.delta;
    level.available = level.onHand - level.reserved;
    levels.set(key, level);
  }
  return levels;
}

export function availableFor(
  levels: Map<string, InventoryLevel>,
  variantId: string,
  locationId?: string,
): number {
  if (locationId) {
    return levels.get(levelKey(variantId, locationId))?.available ?? 0;
  }
  let total = 0;
  for (const level of levels.values()) {
    if (level.variantId === variantId) total += level.available;
  }
  return total;
}

export interface StockRequest {
  variantId: string;
  quantity: number;
  locationId: string;
}

/**
 * Decide whether a set of lines can be sold, without mutating anything.
 *
 * Returned as a report rather than a boolean so the storefront can say "2 of
 * the 3 you wanted" instead of failing the whole basket, which is the
 * difference between a recovered sale and an abandoned one.
 */
export interface StockDecision {
  ok: boolean;
  lines: {
    variantId: string;
    requested: number;
    fulfillable: number;
    reason?: 'out_of_stock' | 'partial' | 'not_tracked' | 'backorder';
  }[];
}

export function checkStock(
  requests: StockRequest[],
  variants: Map<string, Pick<Variant, 'trackInventory' | 'allowBackorder'>>,
  levels: Map<string, InventoryLevel>,
): StockDecision {
  const lines = requests.map((r) => {
    const variant = variants.get(r.variantId);
    if (!variant || !variant.trackInventory) {
      return { variantId: r.variantId, requested: r.quantity, fulfillable: r.quantity, reason: 'not_tracked' as const };
    }
    if (variant.allowBackorder) {
      return { variantId: r.variantId, requested: r.quantity, fulfillable: r.quantity, reason: 'backorder' as const };
    }
    const available = availableFor(levels, r.variantId, r.locationId);
    const fulfillable = Math.max(0, Math.min(r.quantity, available));
    if (fulfillable === r.quantity) return { variantId: r.variantId, requested: r.quantity, fulfillable };
    return {
      variantId: r.variantId,
      requested: r.quantity,
      fulfillable,
      reason: fulfillable === 0 ? ('out_of_stock' as const) : ('partial' as const),
    };
  });
  return { ok: lines.every((l) => l.fulfillable === l.requested), lines };
}

export interface Reservation {
  id: string;
  siteId: SiteId;
  cartId: string;
  lines: StockRequest[];
  createdAt: string;
  /** Reservations must expire, or an abandoned cart holds stock forever. */
  expiresAt: string;
  releasedAt?: string;
}

export function isExpired(reservation: Reservation, now: Date): boolean {
  return !reservation.releasedAt && Date.parse(reservation.expiresAt) <= now.getTime();
}

/**
 * Movements that release every expired reservation.
 *
 * Run on a schedule. Written as a pure function returning the movements to
 * append rather than mutating, so the sweep is testable and its effect is
 * visible in the same ledger as everything else.
 */
export function expireReservations(
  reservations: Reservation[],
  now: Date,
  makeId: () => string,
): { movements: InventoryMovement[]; expired: Reservation[] } {
  const expired = reservations.filter((r) => isExpired(r, now));
  const movements = expired.flatMap((r) =>
    r.lines.map((line): InventoryMovement => ({
      id: makeId(),
      siteId: r.siteId,
      variantId: line.variantId,
      locationId: line.locationId,
      delta: line.quantity,
      reason: 'reservation_released',
      referenceId: r.id,
      note: 'cart expired',
      createdAt: now.toISOString(),
    })));
  return { movements, expired };
}

/** Variants at or below their reorder point, worst first. */
export function lowStock(
  levels: Map<string, InventoryLevel>,
  reorderPoints: Map<string, number>,
  defaultPoint = 0,
): { variantId: string; locationId: string; available: number; reorderPoint: number }[] {
  const out: { variantId: string; locationId: string; available: number; reorderPoint: number }[] = [];
  for (const level of levels.values()) {
    const point = reorderPoints.get(level.variantId) ?? defaultPoint;
    if (level.available <= point) {
      out.push({ variantId: level.variantId, locationId: level.locationId, available: level.available, reorderPoint: point });
    }
  }
  return out.sort((a, b) => a.available - b.available || a.variantId.localeCompare(b.variantId));
}
