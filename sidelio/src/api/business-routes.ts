/**
 * HTTP surface for the business modules.
 *
 * Registered against the same route table as the site routes, so every request
 * goes through the same authorize → act → audit lifecycle. The rule this file
 * exists to keep is that the *domain* modules make every decision: a route
 * validates shape, calls one pure function, and records what happened. Any
 * business rule implemented here rather than in the module would be missing
 * from the scheduled jobs and the storefront that also call it.
 */

import { err } from '../core/errors.ts';
import type { Permission } from '../core/permissions.ts';
import { requireCan } from '../core/permissions.ts';
import { money } from '../commerce/money.ts';
import { priceCart, type Discount, type PricingLine } from '../commerce/pricing.ts';
import {
  availableFor, checkStock, levelsFrom, lowStock, missingVariants, validateProduct,
} from '../commerce/catalog.ts';
import {
  assertOrderConsistent, cancelOrder, capturePayment, createOrder, fulfil,
  outstandingBalance, refundPayment, restockMovementsFor,
} from '../commerce/orders.ts';
import { generateSlots, localDateString } from '../scheduling/availability.ts';
import {
  activeBookings, cancelBooking, createBooking, expandOccurrences,
  occurrencesBetween, register, seatsRemaining, toIcs,
} from '../scheduling/bookings.ts';
import {
  contactFieldsFrom, scoreSpam, submissionsToCsv, validateSubmission,
} from '../crm/forms.ts';
import {
  contactsToCsv, findContact, hasConsent, moveDeal, summarisePipeline,
  timelineFor, upsertContact, withdrawConsent,
} from '../crm/contacts.ts';
import {
  describeAutomation, dispatch, validateAutomation, type ActionHandler,
} from '../automation/engine.ts';
import {
  auditRedirects, canServe, certificatesDue, flattenRedirects, normalizeHostname,
  publish, requiredDnsRecords, robotsTxt, rollback, shouldForceHttps,
} from '../publishing/domains.ts';
import {
  byDay, checkLimits, rollUp, summarise, topPages, topSources,
} from '../analytics/metrics.ts';
import { CURRENCY, type BusinessState } from './business-store.ts';
import { ORG_ID, SITE_ID, USER_ID, type AppStore } from './store.ts';

export interface BusinessCtx {
  store: AppStore;
  business: BusinessState;
  params: Record<string, string>;
  body: unknown;
  res: { writeHead(code: number, headers: Record<string, string>): void; end(chunk?: string): void };
  now: Date;
  makeId: (prefix: string) => string;
  authorize: (permission: Permission) => void;
}

export type BusinessHandler = (ctx: BusinessCtx) => unknown;

export interface BusinessRoute {
  method: string;
  path: string;
  handler: BusinessHandler;
}

export const BUSINESS_ROUTES: BusinessRoute[] = [];

function route(method: string, path: string, handler: BusinessHandler) {
  BUSINESS_ROUTES.push({ method, path, handler });
}

const TARGET = { ipv4: ['203.0.113.10'], ipv6: ['2001:db8::10'], cname: 'sites.sidelio.net' };

/* ------------------------------------------------------------------ */
/* Commerce                                                            */
/* ------------------------------------------------------------------ */

route('GET', '/api/commerce/products', ({ business, authorize }) => {
  authorize('commerce:read');
  const levels = levelsFrom(business.movements);
  return {
    products: business.products.map((product) => ({
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      variants: product.variants.map((v) => ({
        id: v.id,
        title: v.optionValues.join(' / ') || 'Default',
        sku: v.sku ?? null,
        price: v.price,
        compareAtPrice: v.compareAtPrice ?? null,
        available: v.trackInventory ? availableFor(levels, v.id) : null,
      })),
      // Surfaced rather than hidden: a declared combination with no variant
      // is a listing customers can select and then fail to buy.
      missingCombinations: missingVariants(product).length,
      issues: validateProduct(product).ok ? [] : [String((validateProduct(product) as { error: Error }).error.message)],
    })),
    lowStock: lowStock(levels, new Map(), 5),
  };
});

route('POST', '/api/commerce/quote', ({ business, body, authorize }) => {
  authorize('commerce:read');
  const input = body as { lines?: { variantId: string; quantity: number }[]; discountCode?: string; shippingMinor?: number };
  const variants = new Map(business.products.flatMap((p) => p.variants.map((v) => [v.id, { product: p, variant: v }])));

  const lines: PricingLine[] = [];
  for (const requested of input.lines ?? []) {
    const found = variants.get(requested.variantId);
    if (!found) throw err('NOT_FOUND', `no such variant: ${requested.variantId}`);
    lines.push({
      id: `${requested.variantId}`,
      unitPrice: found.variant.price,
      quantity: requested.quantity,
      ...(found.variant.taxClass ? { taxClass: found.variant.taxClass } : {}),
      productId: found.product.id,
      requiresShipping: found.variant.requiresShipping,
    });
  }

  const discounts: Discount[] = input.discountCode === 'WELCOME10'
    ? [{ id: 'dsc_welcome', code: 'WELCOME10', label: '10% off your first order', scope: 'order', value: { kind: 'percentage', percent: 10 } }]
    : [];

  const cart = priceCart({
    currency: CURRENCY,
    lines,
    discounts,
    shipping: money(input.shippingMinor ?? 0, CURRENCY),
    taxRates: [
      { id: 'gst', label: 'GST', rate: 0.05, appliesToShipping: true },
      { id: 'pst', label: 'PST', rate: 0.10, appliesToShipping: true },
    ],
  });

  const levels = levelsFrom(business.movements);
  const stock = checkStock(
    (input.lines ?? []).map((l) => ({ variantId: l.variantId, quantity: l.quantity, locationId: 'loc_yard' })),
    new Map([...variants].map(([id, v]) => [id, { trackInventory: v.variant.trackInventory, allowBackorder: v.variant.allowBackorder }])),
    levels,
  );

  return { cart, stock };
});

route('GET', '/api/commerce/orders', ({ business, authorize }) => {
  authorize('commerce:read');
  return {
    orders: business.orders.map((order) => ({
      id: order.id,
      number: order.number,
      email: order.email,
      total: order.total,
      outstanding: outstandingBalance(order),
      paymentStatus: order.paymentStatus,
      fulfilmentStatus: order.fulfilmentStatus,
      placedAt: order.placedAt,
      lineCount: order.lines.length,
    })),
  };
});

route('POST', '/api/commerce/orders', async ({ store, business, body, authorize, now, makeId }) => {
  authorize('commerce:manage_orders');
  const input = body as {
    email?: string;
    lines?: { variantId: string; quantity: number }[];
    shippingAddress?: Record<string, string>;
  };

  const variants = new Map(business.products.flatMap((p) => p.variants.map((v) => [v.id, { product: p, variant: v }])));
  const lines: PricingLine[] = [];
  const details = new Map<string, { variantId: string; productId: string; title: string; sku?: string; requiresShipping: boolean }>();

  for (const requested of input.lines ?? []) {
    const found = variants.get(requested.variantId);
    if (!found) throw err('NOT_FOUND', `no such variant: ${requested.variantId}`);
    lines.push({
      id: requested.variantId,
      unitPrice: found.variant.price,
      quantity: requested.quantity,
      requiresShipping: found.variant.requiresShipping,
    });
    details.set(requested.variantId, {
      variantId: found.variant.id,
      productId: found.product.id,
      title: [found.product.title, found.variant.optionValues.join(' / ')].filter(Boolean).join(' — '),
      ...(found.variant.sku ? { sku: found.variant.sku } : {}),
      requiresShipping: found.variant.requiresShipping,
    });
  }

  const cart = priceCart({
    currency: CURRENCY, lines,
    taxRates: [{ id: 'gst', label: 'GST', rate: 0.05 }, { id: 'pst', label: 'PST', rate: 0.10 }],
  });

  const created = createOrder({
    siteId: SITE_ID,
    number: `#${1000 + business.orders.length + 1}`,
    email: String(input.email ?? ''),
    cart,
    lineDetails: details,
    ...(input.shippingAddress
      ? { shippingAddress: input.shippingAddress as unknown as Parameters<typeof createOrder>[0]['shippingAddress'] }
      : {}),
    now, makeId,
  });
  if (!created.ok) throw created.error;
  assertOrderConsistent(created.value);

  business.orders.push(created.value);
  // Stock leaves the building when the order is placed, not when it ships —
  // otherwise the same unit is sold twice while it waits to be picked.
  for (const line of created.value.lines) {
    business.movements.push({
      id: makeId('inv'), siteId: store.site.id, variantId: line.variantId,
      locationId: 'loc_yard', delta: -line.quantity, reason: 'sold',
      referenceId: created.value.id, createdAt: now.toISOString(),
    });
  }

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID,
    category: 'commerce', action: 'order.create', outcome: 'success',
    permission: 'commerce:manage_orders',
    metadata: { orderId: created.value.id, total: created.value.total.amount },
  });

  return { order: created.value };
});

route('POST', '/api/commerce/orders/:orderId/capture', async ({ store, business, params, body, authorize, now, makeId }) => {
  authorize('commerce:manage_orders');
  const order = business.orders.find((o) => o.id === params['orderId']);
  if (!order) throw err('NOT_FOUND', 'order not found');

  const input = body as { amountMinor?: number; idempotencyKey?: string };
  const result = capturePayment(order, {
    amount: money(input.amountMinor ?? order.total.amount, CURRENCY),
    provider: 'manual',
    idempotencyKey: String(input.idempotencyKey ?? makeId('key')),
    now, makeId,
  });
  if (!result.ok) throw result.error;
  assertOrderConsistent(result.value);
  business.orders[business.orders.indexOf(order)] = result.value;

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID,
    category: 'commerce', action: 'order.capture', outcome: 'success',
    permission: 'commerce:manage_orders',
    metadata: { orderId: order.id, status: result.value.paymentStatus },
  });
  return { order: result.value };
});

route('POST', '/api/commerce/orders/:orderId/refund', async ({ store, business, params, body, authorize, now, makeId }) => {
  authorize('commerce:refund');
  const order = business.orders.find((o) => o.id === params['orderId']);
  if (!order) throw err('NOT_FOUND', 'order not found');

  const input = body as { amountMinor?: number; lines?: { lineId: string; quantity: number }[]; reason?: string; restock?: boolean; idempotencyKey?: string };
  const result = refundPayment(order, {
    amount: money(input.amountMinor ?? 0, CURRENCY),
    provider: 'manual',
    idempotencyKey: String(input.idempotencyKey ?? makeId('key')),
    ...(input.lines ? { lines: input.lines } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    now, makeId,
  });
  if (!result.ok) throw result.error;
  assertOrderConsistent(result.value);
  business.orders[business.orders.indexOf(order)] = result.value;

  if (input.restock && input.lines) {
    business.movements.push(...restockMovementsFor(result.value, input.lines, 'loc_yard', now, () => makeId('inv')));
  }

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID,
    category: 'commerce', action: 'order.refund', outcome: 'success',
    permission: 'commerce:refund',
    metadata: { orderId: order.id, amount: input.amountMinor ?? 0, restocked: Boolean(input.restock) },
  });
  return { order: result.value };
});

route('POST', '/api/commerce/orders/:orderId/fulfil', async ({ store, business, params, body, authorize, now, makeId }) => {
  authorize('commerce:manage_orders');
  const order = business.orders.find((o) => o.id === params['orderId']);
  if (!order) throw err('NOT_FOUND', 'order not found');
  const input = body as { lines?: { lineId: string; quantity: number }[]; carrier?: string; trackingNumber?: string };

  const result = fulfil(order, {
    lines: input.lines ?? order.lines.map((l) => ({ lineId: l.id, quantity: l.quantity - l.quantityFulfilled - l.quantityRefunded })),
    ...(input.carrier ? { carrier: input.carrier } : {}),
    ...(input.trackingNumber ? { trackingNumber: input.trackingNumber } : {}),
    now, makeId,
  });
  if (!result.ok) throw result.error;
  assertOrderConsistent(result.value);
  business.orders[business.orders.indexOf(order)] = result.value;

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID,
    category: 'commerce', action: 'order.fulfil', outcome: 'success',
    permission: 'commerce:manage_orders',
    metadata: { orderId: order.id, status: result.value.fulfilmentStatus },
  });
  return { order: result.value };
});

route('POST', '/api/commerce/orders/:orderId/cancel', ({ business, params, body, authorize, now, makeId }) => {
  authorize('commerce:manage_orders');
  const order = business.orders.find((o) => o.id === params['orderId']);
  if (!order) throw err('NOT_FOUND', 'order not found');
  const result = cancelOrder(order, { reason: String((body as { reason?: string }).reason ?? 'cancelled'), now, makeId });
  if (!result.ok) throw result.error;
  business.orders[business.orders.indexOf(order)] = result.value;
  return { order: result.value };
});

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

route('GET', '/api/scheduling/services', ({ business, authorize }) => {
  authorize('booking:read');
  return {
    services: business.services,
    resources: business.resources.map((r) => ({ id: r.id, name: r.name, kind: r.kind, capacity: r.capacity })),
  };
});

route('GET', '/api/scheduling/slots', ({ business, params, authorize, now }) => {
  authorize('booking:read');
  const serviceId = params['serviceId'] ?? '';
  const service = business.services.find((s) => s.id === serviceId) ?? business.services[0];
  if (!service) throw err('NOT_FOUND', 'no bookable services');
  const resource = business.resources.find((r) => service.resourceIds.includes(r.id)) ?? business.resources[0];
  if (!resource) throw err('NOT_FOUND', 'no resources');

  const dates = Array.from({ length: 14 }, (_, i) =>
    localDateString(new Date(now.getTime() + i * 86400000), resource.schedule.timezone));

  const slots = generateSlots({
    schedule: resource.schedule,
    rules: { ...service.slotRules, capacity: resource.capacity },
    dates,
    busy: activeBookings(business.bookings.filter((b) => b.resourceId === resource.id))
      .map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
    now,
  });

  return {
    serviceId: service.id,
    resourceId: resource.id,
    timezone: resource.schedule.timezone,
    slots: slots.slice(0, 120).map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString(), remaining: s.remaining })),
  };
});

route('POST', '/api/scheduling/bookings', async ({ store, business, body, authorize, now, makeId }) => {
  authorize('booking:manage');
  const input = body as {
    serviceId?: string; resourceId?: string; start?: string;
    name?: string; email?: string; phone?: string; answers?: Record<string, string>;
  };
  const service = business.services.find((s) => s.id === input.serviceId);
  if (!service) throw err('NOT_FOUND', 'no such service');
  const resource = business.resources.find((r) => r.id === input.resourceId)
    ?? business.resources.find((r) => service.resourceIds.includes(r.id));
  if (!resource) throw err('NOT_FOUND', 'no such resource');

  const created = createBooking({
    siteId: store.site.id, service, resource,
    start: new Date(String(input.start)),
    customerName: String(input.name ?? ''),
    customerEmail: String(input.email ?? ''),
    ...(input.phone ? { customerPhone: input.phone } : {}),
    ...(input.answers ? { answers: input.answers } : {}),
    existing: business.bookings.filter((b) => b.resourceId === resource.id),
    now, makeId,
  });
  if (!created.ok) throw created.error;
  business.bookings.push(created.value);

  // A booking is also a person: the CRM record is created from the same act,
  // not by a later sync that can silently stop running.
  const existing = findContact(business.contacts, { email: created.value.customerEmail });
  const contact = upsertContact(existing, {
    siteId: store.site.id,
    email: created.value.customerEmail,
    ...(created.value.customerPhone ? { phone: created.value.customerPhone } : {}),
    name: created.value.customerName,
    tags: ['booking'],
    now, makeId,
  });
  if (contact.ok) {
    if (existing) business.contacts[business.contacts.indexOf(existing)] = contact.value;
    else business.contacts.push(contact.value);
    business.activities.push({
      id: makeId('act'), siteId: store.site.id, contactId: contact.value.id,
      kind: 'booking_made', summary: `Booked ${service.name}`,
      referenceId: created.value.id, at: now.toISOString(),
    });
  }

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID,
    category: 'content', action: 'booking.create', outcome: 'success',
    permission: 'booking:manage',
    metadata: { bookingId: created.value.id, serviceId: service.id },
  });

  return { booking: created.value };
});

route('POST', '/api/scheduling/bookings/:bookingId/cancel', ({ business, params, body, authorize, now }) => {
  authorize('booking:manage');
  const booking = business.bookings.find((b) => b.id === params['bookingId']);
  if (!booking) throw err('NOT_FOUND', 'booking not found');
  const service = business.services.find((s) => s.id === booking.serviceId);
  const result = cancelBooking(booking, {
    reason: String((body as { reason?: string }).reason ?? 'cancelled'),
    byStaff: true, now,
    ...(service?.cancellationPolicyHours ? { policyHours: service.cancellationPolicyHours } : {}),
  });
  if (!result.ok) throw result.error;
  business.bookings[business.bookings.indexOf(booking)] = result.value;
  return { booking: result.value };
});

route('GET', '/api/scheduling/events', ({ business, authorize, now }) => {
  authorize('event:read');
  return {
    events: business.events.map((event) => {
      const expanded = expandOccurrences(event);
      const occurrences = expanded.ok ? expanded.value : [];
      return {
        id: event.id,
        title: event.title,
        status: event.status,
        timezone: event.timezone,
        ticketTypes: event.ticketTypes,
        occurrences: occurrencesBetween(occurrences, now, new Date(now.getTime() + 180 * 86400000))
          .map((o) => ({
            id: o.id, start: o.start, end: o.end,
            remaining: seatsRemaining(o, business.registrations) ?? null,
          })),
      };
    }),
  };
});

route('POST', '/api/scheduling/events/:eventId/register', ({ store, business, params, body, authorize, now, makeId }) => {
  authorize('event:manage');
  const event = business.events.find((e) => e.id === params['eventId']);
  if (!event) throw err('NOT_FOUND', 'event not found');
  const expanded = expandOccurrences(event);
  if (!expanded.ok) throw expanded.error;

  const input = body as { occurrenceId?: string; ticketTypeId?: string; name?: string; email?: string; quantity?: number };
  const occurrence = expanded.value.find((o) => o.id === input.occurrenceId) ?? expanded.value[0];
  if (!occurrence) throw err('NOT_FOUND', 'no upcoming dates');

  const result = register({
    siteId: store.site.id, event, occurrence,
    ticketTypeId: String(input.ticketTypeId ?? event.ticketTypes[0]?.id),
    name: String(input.name ?? ''), email: String(input.email ?? ''),
    quantity: Number(input.quantity ?? 1),
    existing: business.registrations, now, makeId,
  });
  if (!result.ok) throw result.error;
  business.registrations.push(result.value);
  return { registration: result.value };
});

route('GET', '/api/scheduling/events/:eventId/ics', ({ business, params, res, authorize }) => {
  authorize('event:read');
  const event = business.events.find((e) => e.id === params['eventId']);
  if (!event) throw err('NOT_FOUND', 'event not found');
  const expanded = expandOccurrences(event);
  const ics = toIcs(event, expanded.ok ? expanded.value : [], 'https://acmeroofing.ca');
  res.writeHead(200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="${event.id}.ics"`,
  });
  res.end(ics);
  return undefined;
});

/* ------------------------------------------------------------------ */
/* Forms and CRM                                                       */
/* ------------------------------------------------------------------ */

route('GET', '/api/forms', ({ business, authorize }) => {
  authorize('form:read');
  return {
    forms: business.forms.map((form) => ({
      id: form.id, name: form.name, active: form.active,
      fieldCount: form.fields.length,
      submissions: business.submissions.filter((s) => s.formId === form.id).length,
      spam: business.submissions.filter((s) => s.formId === form.id && s.status === 'spam').length,
    })),
    submissions: business.submissions.slice(-50).reverse(),
  };
});

route('POST', '/api/forms/:formId/submissions', async ({ store, business, params, body, now, makeId }) => {
  // Deliberately unauthenticated: this is the public endpoint a visitor posts
  // to. Everything that protects it is in the domain module, not in a
  // permission check that a visitor could never satisfy.
  const form = business.forms.find((f) => f.id === params['formId']);
  if (!form || !form.active) throw err('NOT_FOUND', 'form not found');

  const raw = (body ?? {}) as Record<string, unknown>;
  const validated = validateSubmission(form, raw);
  if (!validated.ok) {
    throw err('VALIDATION_FAILED', 'some answers need attention', {
      userMessage: 'Please check the highlighted fields.',
      details: validated.error.map((e) => ({ field: e.key, message: e.message })),
    });
  }

  const verdict = scoreSpam(form, {
    ...(typeof raw[form.spamProtection.honeypotField] === 'string'
      ? { honeypotValue: raw[form.spamProtection.honeypotField] as string }
      : {}),
    ...(typeof raw['_elapsed'] === 'number' ? { secondsToComplete: raw['_elapsed'] as number } : {}),
    values: validated.value.values,
  });

  const submission = {
    id: makeId('sub'), siteId: store.site.id, formId: form.id,
    values: validated.value.values,
    meta: { submittedAt: now.toISOString() },
    spamScore: verdict.score,
    // Flagged, never dropped: a wrongly binned enquiry is a customer who
    // believes they were ignored.
    status: verdict.isSpam ? ('spam' as const) : ('new' as const),
    ...(validated.value.consent ? { consent: validated.value.consent } : {}),
  };

  const fields = contactFieldsFrom(form, validated.value.values);
  const existing = findContact(business.contacts, {
    ...(fields.email ? { email: fields.email } : {}),
    ...(fields.phone ? { phone: fields.phone } : {}),
  });
  const contact = upsertContact(existing, {
    siteId: store.site.id,
    ...(fields.email ? { email: fields.email } : {}),
    ...(fields.phone ? { phone: fields.phone } : {}),
    ...(fields.name ? { name: fields.name } : {}),
    tags: form.tags ?? [],
    ...(validated.value.consent
      ? {
        consent: {
          channel: 'email_marketing' as const, basis: 'express' as const, granted: true,
          text: validated.value.consent.text, source: `form:${form.id}`, at: validated.value.consent.at,
        },
      }
      : {}),
    now, makeId,
  });

  if (contact.ok) {
    if (existing) business.contacts[business.contacts.indexOf(existing)] = contact.value;
    else business.contacts.push(contact.value);
    (submission as { contactId?: string }).contactId = contact.value.id;
    business.activities.push({
      id: makeId('act'), siteId: store.site.id, contactId: contact.value.id,
      kind: 'form_submitted', summary: `Submitted "${form.name}"`,
      referenceId: submission.id, at: now.toISOString(),
    });
  }

  business.submissions.push(submission);

  const runs = await dispatch({
    automations: business.automations,
    triggerKind: 'form_submitted',
    payload: { formId: form.id, values: validated.value.values, spamScore: verdict.score },
    ...(contact.ok ? { contactId: contact.value.id } : {}),
    idempotencyKey: submission.id,
    existingRuns: business.runs,
    handler: recordingHandler(business, makeId, now),
    now, makeId,
  });
  business.runs.push(...runs);

  return {
    ok: true,
    message: form.successBehaviour.kind === 'message' ? form.successBehaviour.message : undefined,
    submissionId: submission.id,
    automationsRun: runs.filter((r) => r.status === 'completed').length,
  };
});

route('GET', '/api/forms/:formId/export', ({ business, params, res, authorize }) => {
  authorize('submission:export');
  const form = business.forms.find((f) => f.id === params['formId']);
  if (!form) throw err('NOT_FOUND', 'form not found');
  const csv = submissionsToCsv(form, business.submissions.filter((s) => s.formId === form.id));
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${form.id}-submissions.csv"`,
  });
  res.end(csv);
  return undefined;
});

route('GET', '/api/crm/contacts', ({ business, authorize, now }) => {
  authorize('form:read');
  return {
    contacts: business.contacts.map((c) => ({
      id: c.id, name: c.name ?? null, email: c.email ?? null, phone: c.phone ?? null,
      tags: c.tags, erased: Boolean(c.erasedAt),
      emailMarketing: hasConsent(c, 'email_marketing', now),
      lastActivityAt: c.lastActivityAt ?? null,
    })),
    pipeline: summarisePipeline(business.stages, business.deals),
    stages: business.stages,
  };
});

route('GET', '/api/crm/contacts/:contactId', ({ business, params, authorize, now }) => {
  authorize('form:read');
  const contact = business.contacts.find((c) => c.id === params['contactId']);
  if (!contact) throw err('NOT_FOUND', 'contact not found');
  return {
    contact,
    consented: hasConsent(contact, 'email_marketing', now),
    timeline: timelineFor(business.activities, contact.id),
    deals: business.deals.filter((d) => d.contactId === contact.id),
  };
});

route('POST', '/api/crm/contacts/:contactId/unsubscribe', ({ business, params, authorize, now }) => {
  authorize('form:update');
  const contact = business.contacts.find((c) => c.id === params['contactId']);
  if (!contact) throw err('NOT_FOUND', 'contact not found');
  const updated = withdrawConsent(contact, 'email_marketing', 'admin', now);
  business.contacts[business.contacts.indexOf(contact)] = updated;
  return { contact: updated, consented: hasConsent(updated, 'email_marketing', now) };
});

route('POST', '/api/crm/deals/:dealId/stage', ({ business, params, body, authorize, now }) => {
  authorize('form:update');
  const deal = business.deals.find((d) => d.id === params['dealId']);
  if (!deal) throw err('NOT_FOUND', 'deal not found');
  const input = body as { stageId?: string; lostReason?: string };
  const stage = business.stages.find((s) => s.id === input.stageId);
  if (!stage) throw err('NOT_FOUND', 'stage not found');
  const moved = moveDeal(deal, stage, now, input.lostReason);
  if (!moved.ok) throw moved.error;
  business.deals[business.deals.indexOf(deal)] = moved.value;
  return { deal: moved.value };
});

route('GET', '/api/crm/export', ({ business, res, authorize, now }) => {
  authorize('submission:export');
  const csv = contactsToCsv(business.contacts, now);
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="contacts.csv"',
  });
  res.end(csv);
  return undefined;
});

/* ------------------------------------------------------------------ */
/* Automations                                                         */
/* ------------------------------------------------------------------ */

route('GET', '/api/automations', ({ business, authorize }) => {
  authorize('automation:read');
  return {
    automations: business.automations.map((a) => ({
      id: a.id, name: a.name, enabled: a.enabled,
      description: describeAutomation(a),
      trigger: a.trigger.kind,
      actionCount: a.actions.length,
      runs: business.runs.filter((r) => r.automationId === a.id).length,
      failures: business.runs.filter((r) => r.automationId === a.id && r.status === 'failed').length,
    })),
    // Skips are shown alongside runs: "why didn't it fire?" is the most
    // common question about an automation, and silence is not an answer.
    recentRuns: business.runs.slice(-40).reverse().map((r) => ({
      id: r.id, automationId: r.automationId, status: r.status,
      reason: r.reason ?? null, startedAt: r.startedAt, steps: r.steps.length,
    })),
  };
});

route('POST', '/api/automations/:automationId/toggle', ({ business, params, authorize, now }) => {
  authorize('automation:manage');
  const automation = business.automations.find((a) => a.id === params['automationId']);
  if (!automation) throw err('NOT_FOUND', 'automation not found');
  const updated = { ...automation, enabled: !automation.enabled, updatedAt: now.toISOString() };
  const valid = validateAutomation(updated);
  if (!valid.ok) throw valid.error;
  business.automations[business.automations.indexOf(automation)] = updated;
  return { automation: updated };
});

/**
 * Action handler used by the demo API.
 *
 * Effects that leave the platform — email, SMS, webhooks — are reported as
 * skipped rather than faked. A handler that pretends to have sent an email is
 * exactly the silent failure the engine is built to prevent.
 */
function recordingHandler(business: BusinessState, makeId: (p: string) => string, now: Date): ActionHandler {
  return (action, ctx) => {
    switch (action.kind) {
      case 'add_tag': {
        const contact = business.contacts.find((c) => c.id === ctx.contactId);
        if (!contact) return { action, status: 'skipped', detail: 'no contact on this trigger' };
        contact.tags = [...new Set([...contact.tags, action.tag])];
        return { action, status: 'ok', detail: `tagged "${action.tag}"` };
      }
      case 'create_deal': {
        if (!ctx.contactId) return { action, status: 'skipped', detail: 'no contact on this trigger' };
        business.deals.push({
          id: makeId('dl'), siteId: ctx.siteId, contactId: ctx.contactId,
          title: action.title, stageId: action.stageId,
          createdAt: now.toISOString(), updatedAt: now.toISOString(),
        });
        return { action, status: 'ok', detail: `created deal "${action.title}"` };
      }
      case 'send_email':
      case 'send_sms':
      case 'notify_webhook':
        return { action, status: 'skipped', detail: 'no delivery provider is configured in this build' };
      default:
        return { action, status: 'ok' };
    }
  };
}

/* ------------------------------------------------------------------ */
/* Domains and publishing                                              */
/* ------------------------------------------------------------------ */

route('GET', '/api/publishing/domains', ({ business, authorize, now }) => {
  authorize('domain:read');
  return {
    domains: business.domains.map((d) => ({
      id: d.id, hostname: d.hostname, status: d.status, isPrimary: d.isPrimary,
      servable: canServe(d), forcingHttps: shouldForceHttps(d, now),
      verifiedAt: d.verifiedAt ?? null, lastError: d.lastError ?? null,
      certificate: d.certificate ?? null,
      records: requiredDnsRecords(d, TARGET),
    })),
    renewalsDue: certificatesDue(business.domains, now).map((d) => d.hostname),
  };
});

route('POST', '/api/publishing/domains', ({ store, business, body, authorize, now, makeId }) => {
  authorize('domain:manage');
  const normalized = normalizeHostname(String((body as { hostname?: string }).hostname ?? ''));
  if (!normalized.ok) throw normalized.error;
  if (business.domains.some((d) => d.hostname === normalized.value)) {
    throw err('CONFLICT', 'that domain is already connected to this site');
  }
  const domain = {
    id: makeId('dom') as unknown as (typeof business.domains)[number]['id'],
    siteId: store.site.id,
    hostname: normalized.value,
    isPrimary: business.domains.length === 0,
    status: 'pending_dns' as const,
    verificationToken: `sidelio-verify-${makeId('t').slice(-8)}`,
    forceHttps: true,
    createdAt: now.toISOString(),
  };
  business.domains.push(domain);
  return { domain, records: requiredDnsRecords(domain, TARGET) };
});

route('GET', '/api/publishing/redirects', ({ business, authorize }) => {
  authorize('site:read');
  return {
    redirects: business.redirects,
    problems: auditRedirects(business.redirects),
  };
});

route('POST', '/api/publishing/redirects/flatten', ({ business, authorize }) => {
  authorize('site:update');
  business.redirects = flattenRedirects(business.redirects);
  return { redirects: business.redirects, problems: auditRedirects(business.redirects) };
});

route('GET', '/api/publishing/versions', ({ business, authorize }) => {
  authorize('site:read');
  return { versions: [...business.versions].reverse() };
});

route('POST', '/api/publishing/publish', async ({ store, business, body, authorize, now, makeId }) => {
  authorize('page:publish');
  const pages = store.pages();
  const checks = publishChecks(store, business);

  const result = publish({
    siteId: store.site.id,
    pageCount: pages.length,
    digest: digestOf(pages.map((p) => `${p.path}:${p.updatedAt}`).join('|')),
    publishedBy: USER_ID,
    ...(business.versions.length ? { previous: business.versions[business.versions.length - 1] } : {}),
    checks,
    acknowledgeWarnings: Boolean((body as { acknowledgeWarnings?: boolean }).acknowledgeWarnings),
    now, makeId,
  });

  if (!result.ok) {
    return { published: false, blocking: result.error.blocking, warnings: result.error.warnings };
  }
  if (!business.versions.some((v) => v.id === result.value.id)) business.versions.push(result.value);

  await store.auditor.record({
    orgId: ORG_ID, siteId: SITE_ID, actorId: USER_ID,
    category: 'publish', action: 'site.publish', outcome: 'success', permission: 'page:publish',
    metadata: { version: result.value.number, pages: pages.length },
  });

  return { published: true, version: result.value };
});

route('POST', '/api/publishing/rollback/:versionId', ({ store, business, params, authorize, now, makeId }) => {
  authorize('page:publish');
  const target = business.versions.find((v) => v.id === params['versionId']);
  const current = business.versions[business.versions.length - 1];
  if (!target || !current) throw err('NOT_FOUND', 'no such version');
  const result = rollback(target, current, USER_ID, now, makeId);
  if (!result.ok) throw result.error;
  business.versions.push(result.value);
  return { version: result.value };
});

route('GET', '/robots.txt', ({ business, res }) => {
  const live = business.versions.length > 0;
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(robotsTxt({ origin: 'https://acmeroofing.ca', indexable: live }));
  return undefined;
});

function publishChecks(store: AppStore, business: BusinessState) {
  const checks: { id: string; severity: 'blocking' | 'warning'; message: string; fix?: string }[] = [];
  const pages = store.pages();

  if (pages.length === 0) {
    checks.push({ id: 'no_pages', severity: 'blocking', message: 'This site has no pages yet.' });
  }
  const untitled = pages.filter((p) => !p.seo.metaTitle && !p.title.trim());
  if (untitled.length > 0) {
    checks.push({ id: 'untitled', severity: 'blocking', message: `${untitled.length} page(s) have no title.` });
  }
  const pending = store.graph.reviewQueue().length;
  if (pending > 0) {
    // A warning rather than a block: the facts are unapproved, so they will
    // not render, but that is a thin page and not a broken one.
    checks.push({
      id: 'unapproved_facts', severity: 'warning',
      message: `${pending} imported fact(s) are still unapproved and will not appear on the published site.`,
      fix: 'Review them in the Facts queue.',
    });
  }
  const unverified = business.domains.filter((d) => !canServe(d));
  if (unverified.length > 0) {
    checks.push({
      id: 'domain_unverified', severity: 'warning',
      message: `${unverified.length} domain(s) are not verified yet; the site will publish to its sidelio.site address.`,
    });
  }
  return checks;
}

/** Small non-cryptographic digest — this identifies a build, not a secret. */
function digestOf(input: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 + input.charCodeAt(i), 0x85ebca6b);
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, '0');
}

/* ------------------------------------------------------------------ */
/* Analytics, billing, agency                                          */
/* ------------------------------------------------------------------ */

route('GET', '/api/analytics', ({ store, business, authorize, now }) => {
  authorize('analytics:read');
  const timezone = business.resources[0]?.schedule.timezone ?? 'UTC';
  const recent = business.metrics.filter((e) => Date.parse(e.at) >= now.getTime() - 14 * 86400000);
  return {
    totals: summarise(recent),
    byDay: [...byDay(recent, timezone).entries()].map(([day, totals]) => ({ day, ...totals })),
    topPages: topPages(recent),
    topSources: topSources(recent, business.domains[0]?.hostname ?? `${store.site.subdomain}.sidelio.site`),
    timezone,
  };
});

route('GET', '/api/billing', ({ store, business, authorize }) => {
  authorize('billing:manage');
  const usage = {
    sites: 1,
    pages: store.pages().length,
    monthlyPageViews: business.metrics.filter((e) => e.kind === 'page_view').length,
    storageMb: Math.round(store.assets().reduce((n, a) => n + (a.sizeBytes ?? 0), 0) / (1024 * 1024)),
    products: business.products.length,
    staffSeats: 1,
    aiCreditsUsed: 0,
    customDomains: business.domains.length,
  };
  return {
    plan: business.plan,
    subscription: business.subscription,
    usage,
    limits: checkLimits(business.plan, usage),
  };
});

route('GET', '/api/agency', ({ store, business, authorize, now }) => {
  authorize('site:read');
  const recent = business.metrics.filter((e) => Date.parse(e.at) >= now.getTime() - 30 * 86400000);
  const issues: { severity: 'critical' | 'warning'; message: string }[] = [];

  for (const domain of business.domains) {
    if (!canServe(domain)) issues.push({ severity: 'critical', message: `${domain.hostname} is not verified` });
    else if (!shouldForceHttps(domain, now) && domain.forceHttps) {
      issues.push({ severity: 'warning', message: `${domain.hostname} wants HTTPS but has no valid certificate` });
    }
  }
  if (business.versions.length === 0) {
    issues.push({ severity: 'warning', message: 'This site has never been published' });
  }

  return rollUp([{
    siteId: store.site.id,
    name: store.site.name,
    issues,
    ...(business.versions.length
      ? { lastPublishedAt: business.versions[business.versions.length - 1]!.publishedAt }
      : {}),
    totals: summarise(recent),
  }]);
});

export { requireCan };
