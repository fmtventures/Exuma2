/**
 * Bookings and events.
 *
 * Both sit on the availability engine but differ in what is scarce. A booking
 * consumes a *resource's time* — a person can only be in one place — so the
 * constraint is overlap. An event has a *fixed capacity* at a known instant, so
 * the constraint is a count. Modelling them separately keeps each honest;
 * forcing events through slot generation makes capacity a fiction, and forcing
 * bookings through capacity counting permits double bookings.
 *
 * What they share is a strict rule about confirmation: a booking or ticket is
 * only held once it has been checked against *current* state, not the state the
 * customer saw when the page rendered. Everything that grants a place goes
 * through a re-check here.
 */

import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { SiteId, UserId } from '../core/ids.ts';
import type { Money } from '../commerce/money.ts';
import {
  canBook, expandRecurrence, localDateString, overlaps, resolveLocalTime,
  type Interval, type Recurrence, type Schedule, type SlotRules,
} from './availability.ts';

/* ------------------------------------------------------------------ */
/* Bookings                                                            */
/* ------------------------------------------------------------------ */

export interface BookableService {
  id: string;
  siteId: SiteId;
  name: string;
  description?: string;
  durationMinutes: number;
  price?: Money;
  /** Charged when booking rather than after the appointment. */
  depositAmount?: Money;
  /** Resources able to deliver it. Empty means any. */
  resourceIds: string[];
  slotRules: SlotRules;
  /** Questions asked at booking; answers land on the booking. */
  intakeFields?: { key: string; label: string; required: boolean; type: 'text' | 'textarea' | 'select' | 'phone' | 'email'; options?: string[] }[];
  cancellationPolicyHours?: number;
  active: boolean;
}

export interface Resource {
  id: string;
  siteId: SiteId;
  name: string;
  kind: 'person' | 'room' | 'equipment';
  schedule: Schedule;
  /** Time off, holidays, existing external calendar events. */
  blocks?: Interval[];
  /** How many bookings it can run at once — two chairs, four courts. */
  capacity: number;
  active: boolean;
}

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export interface Booking {
  id: string;
  siteId: SiteId;
  serviceId: string;
  resourceId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  start: string;
  end: string;
  status: BookingStatus;
  answers?: Record<string, string>;
  note?: string;
  orderId?: string;
  cancelledAt?: string;
  cancelReason?: string;
  /** Set when the customer is told; used to avoid sending twice. */
  remindedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookingRequest {
  siteId: SiteId;
  service: BookableService;
  resource: Resource;
  start: Date;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  answers?: Record<string, string>;
  /** Every booking already held against this resource. */
  existing: Booking[];
  now: Date;
  makeId: (prefix: string) => string;
}

/** Bookings that still occupy the resource's time. */
export function activeBookings(bookings: Booking[]): Booking[] {
  return bookings.filter((b) => b.status !== 'cancelled' && b.status !== 'no_show');
}

export function bookingInterval(booking: Booking): Interval {
  return { start: new Date(booking.start), end: new Date(booking.end) };
}

/**
 * Create a booking, re-checking availability against current state.
 *
 * The gap between rendering a slot list and the customer pressing confirm is
 * where double bookings are made. Trusting the slot the client sends back is
 * the single most common way a scheduling system oversells.
 */
export function createBooking(request: BookingRequest): Result<Booking> {
  const { service, resource, start, now } = request;

  if (!service.active) return fail(err('CONFLICT', `${service.name} is not currently bookable`));
  if (!resource.active) return fail(err('CONFLICT', `${resource.name} is not currently taking bookings`));
  if (service.resourceIds.length > 0 && !service.resourceIds.includes(resource.id)) {
    return fail(err('VALIDATION_FAILED', `${resource.name} does not provide ${service.name}`));
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(request.customerEmail)) {
    return fail(err('VALIDATION_FAILED', 'a valid email is needed to send the confirmation'));
  }

  for (const field of service.intakeFields ?? []) {
    if (field.required && !request.answers?.[field.key]?.trim()) {
      return fail(err('VALIDATION_FAILED', `"${field.label}" is required`));
    }
  }

  const end = new Date(start.getTime() + service.durationMinutes * 60000);
  const busy = activeBookings(request.existing).map(bookingInterval);

  const allowed = canBook({ start, end }, {
    schedule: resource.schedule,
    rules: { ...service.slotRules, capacity: resource.capacity },
    busy: [...busy, ...(resource.blocks ?? [])],
    now,
  });
  if (!allowed.ok) return fail(allowed.error);

  return ok({
    id: request.makeId('bkg'),
    siteId: request.siteId,
    serviceId: service.id,
    resourceId: resource.id,
    customerName: request.customerName,
    customerEmail: request.customerEmail,
    ...(request.customerPhone ? { customerPhone: request.customerPhone } : {}),
    start: start.toISOString(),
    end: end.toISOString(),
    // A deposit-taking service is not confirmed until the money arrives.
    status: service.depositAmount ? 'pending' : 'confirmed',
    ...(request.answers ? { answers: request.answers } : {}),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
}

export interface CancelBookingInput {
  reason: string;
  now: Date;
  /** Staff may cancel inside the policy window; customers may not. */
  byStaff?: boolean;
  actorId?: UserId;
  policyHours?: number;
}

export function cancelBooking(booking: Booking, input: CancelBookingInput): Result<Booking> {
  if (booking.status === 'cancelled') return ok(booking);
  if (booking.status === 'completed') {
    return fail(err('CONFLICT', 'a completed appointment cannot be cancelled'));
  }

  const hours = input.policyHours ?? 0;
  if (!input.byStaff && hours > 0) {
    const cutoff = new Date(booking.start).getTime() - hours * 3600000;
    if (input.now.getTime() > cutoff) {
      return fail(err('CONFLICT',
        `this appointment can no longer be cancelled online — it is inside the ${hours}-hour notice period`));
    }
  }

  return ok({
    ...booking,
    status: 'cancelled',
    cancelledAt: input.now.toISOString(),
    cancelReason: input.reason,
    updatedAt: input.now.toISOString(),
  });
}

/**
 * Move a booking, re-checking the new time.
 *
 * The booking's own interval is excluded from the busy list, or it collides
 * with itself and every reschedule fails.
 */
export function rescheduleBooking(
  booking: Booking,
  to: Date,
  ctx: { service: BookableService; resource: Resource; existing: Booking[]; now: Date },
): Result<Booking> {
  if (booking.status === 'cancelled' || booking.status === 'completed') {
    return fail(err('CONFLICT', 'only an upcoming appointment can be moved'));
  }
  const end = new Date(to.getTime() + ctx.service.durationMinutes * 60000);
  const busy = activeBookings(ctx.existing)
    .filter((b) => b.id !== booking.id)
    .map(bookingInterval);

  const allowed = canBook({ start: to, end }, {
    schedule: ctx.resource.schedule,
    rules: { ...ctx.service.slotRules, capacity: ctx.resource.capacity },
    busy: [...busy, ...(ctx.resource.blocks ?? [])],
    now: ctx.now,
  });
  if (!allowed.ok) return fail(allowed.error);

  return ok({ ...booking, start: to.toISOString(), end: end.toISOString(), updatedAt: ctx.now.toISOString() });
}

/** Bookings needing a reminder in this window, never reminded twice. */
export function dueReminders(bookings: Booking[], hoursAhead: number, now: Date): Booking[] {
  const from = now.getTime();
  const to = from + hoursAhead * 3600000;
  return bookings.filter((b) =>
    b.status === 'confirmed'
    && !b.remindedAt
    && Date.parse(b.start) > from
    && Date.parse(b.start) <= to);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export interface TicketType {
  id: string;
  name: string;
  price: Money;
  /** Undefined means limited only by the occurrence's capacity. */
  quantity?: number;
  /** Sales window; outside it the type is listed but not sellable. */
  salesStart?: string;
  salesEnd?: string;
  minPerOrder?: number;
  maxPerOrder?: number;
}

export interface EventDefinition {
  id: string;
  siteId: SiteId;
  title: string;
  description?: string;
  timezone: string;
  /** Local start date of the first occurrence. */
  startDate: string;
  startMinute: number;
  durationMinutes: number;
  recurrence?: Recurrence;
  locationName?: string;
  address?: string;
  onlineUrl?: string;
  capacity?: number;
  ticketTypes: TicketType[];
  /** Keep selling past capacity into a waitlist. */
  waitlistEnabled: boolean;
  status: 'draft' | 'published' | 'cancelled';
}

export interface EventOccurrence {
  id: string;
  eventId: string;
  /** Local date this instance falls on. */
  date: string;
  start: string;
  end: string;
  capacity?: number;
  cancelled?: boolean;
}

export interface Registration {
  id: string;
  siteId: SiteId;
  eventId: string;
  occurrenceId: string;
  ticketTypeId: string;
  name: string;
  email: string;
  quantity: number;
  status: 'confirmed' | 'waitlisted' | 'cancelled' | 'attended';
  orderId?: string;
  createdAt: string;
}

/**
 * Expand an event into its occurrences.
 *
 * Each instance resolves its own wall-clock start, so a weekly evening class
 * stays at 19:00 local across a DST boundary rather than drifting to 18:00 for
 * half the year.
 */
export function expandOccurrences(
  event: EventDefinition,
  limit = 100,
): Result<EventOccurrence[]> {
  const dates = event.recurrence
    ? expandRecurrence(event.startDate, event.recurrence, event.timezone, limit)
    : ok([event.startDate]);
  if (!dates.ok) return fail(dates.error);

  const out: EventOccurrence[] = [];
  for (const date of dates.value) {
    const start = resolveLocalTime(date, event.startMinute, event.timezone);
    if (!start.ok) continue; // a skipped hour simply has no occurrence
    const end = new Date(start.value.getTime() + event.durationMinutes * 60000);
    out.push({
      id: `${event.id}:${date}`,
      eventId: event.id,
      date,
      start: start.value.toISOString(),
      end: end.toISOString(),
      ...(event.capacity !== undefined ? { capacity: event.capacity } : {}),
    });
  }
  return ok(out);
}

export function seatsTaken(registrations: Registration[], occurrenceId: string): number {
  return registrations
    .filter((r) => r.occurrenceId === occurrenceId && r.status === 'confirmed')
    .reduce((n, r) => n + r.quantity, 0);
}

export function seatsRemaining(
  occurrence: EventOccurrence,
  registrations: Registration[],
): number | undefined {
  if (occurrence.capacity === undefined) return undefined;
  return Math.max(0, occurrence.capacity - seatsTaken(registrations, occurrence.id));
}

export interface RegisterInput {
  siteId: SiteId;
  event: EventDefinition;
  occurrence: EventOccurrence;
  ticketTypeId: string;
  name: string;
  email: string;
  quantity: number;
  existing: Registration[];
  now: Date;
  makeId: (prefix: string) => string;
}

/**
 * Register for an occurrence.
 *
 * Capacity is re-counted here rather than trusted from the page, and a
 * registration that would exceed it either waitlists or fails — it never
 * partially confirms, because a customer who paid for four seats and received
 * two has a worse problem than one who was turned away.
 */
export function register(input: RegisterInput): Result<Registration> {
  const { event, occurrence, now } = input;

  if (event.status !== 'published') return fail(err('CONFLICT', 'this event is not open for registration'));
  if (occurrence.cancelled) return fail(err('CONFLICT', 'this date has been cancelled'));
  if (Date.parse(occurrence.start) <= now.getTime()) {
    return fail(err('CONFLICT', 'this event has already started'));
  }

  const ticket = event.ticketTypes.find((t) => t.id === input.ticketTypeId);
  if (!ticket) return fail(err('NOT_FOUND', 'no such ticket type'));
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    return fail(err('VALIDATION_FAILED', 'quantity must be a positive whole number'));
  }
  if (ticket.salesStart && now.getTime() < Date.parse(ticket.salesStart)) {
    return fail(err('CONFLICT', `${ticket.name} is not on sale yet`));
  }
  if (ticket.salesEnd && now.getTime() > Date.parse(ticket.salesEnd)) {
    return fail(err('CONFLICT', `${ticket.name} is no longer on sale`));
  }
  if (ticket.minPerOrder && input.quantity < ticket.minPerOrder) {
    return fail(err('VALIDATION_FAILED', `${ticket.name} has a minimum of ${ticket.minPerOrder}`));
  }
  if (ticket.maxPerOrder && input.quantity > ticket.maxPerOrder) {
    return fail(err('VALIDATION_FAILED', `${ticket.name} has a maximum of ${ticket.maxPerOrder} per order`));
  }

  if (ticket.quantity !== undefined) {
    const sold = input.existing
      .filter((r) => r.occurrenceId === occurrence.id && r.ticketTypeId === ticket.id && r.status === 'confirmed')
      .reduce((n, r) => n + r.quantity, 0);
    if (sold + input.quantity > ticket.quantity) {
      return fail(err('CONFLICT', `only ${Math.max(0, ticket.quantity - sold)} of ${ticket.name} remain`));
    }
  }

  const remaining = seatsRemaining(occurrence, input.existing);
  let status: Registration['status'] = 'confirmed';
  if (remaining !== undefined && input.quantity > remaining) {
    if (!event.waitlistEnabled) {
      return fail(err('CONFLICT', remaining === 0
        ? 'this date is fully booked'
        : `only ${remaining} ${remaining === 1 ? 'place remains' : 'places remain'}`));
    }
    status = 'waitlisted';
  }

  return ok({
    id: input.makeId('reg'),
    siteId: input.siteId,
    eventId: event.id,
    occurrenceId: occurrence.id,
    ticketTypeId: ticket.id,
    name: input.name,
    email: input.email,
    quantity: input.quantity,
    status,
    createdAt: now.toISOString(),
  });
}

/**
 * Promote waitlisted registrations into places that have opened up.
 *
 * Oldest first, and only whole registrations — splitting a party of four to
 * fill three seats gives someone a booking they cannot use.
 */
export function promoteFromWaitlist(
  occurrence: EventOccurrence,
  registrations: Registration[],
  now: Date,
): { promoted: Registration[]; registrations: Registration[] } {
  if (occurrence.capacity === undefined) return { promoted: [], registrations };

  let remaining = seatsRemaining(occurrence, registrations) ?? 0;
  const promoted: Registration[] = [];
  const next = [...registrations];

  const waiting = next
    .filter((r) => r.occurrenceId === occurrence.id && r.status === 'waitlisted')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  for (const entry of waiting) {
    if (entry.quantity > remaining) continue;
    const index = next.indexOf(entry);
    const upgraded: Registration = { ...entry, status: 'confirmed' };
    next[index] = upgraded;
    promoted.push(upgraded);
    remaining -= entry.quantity;
  }

  void now;
  return { promoted, registrations: next };
}

/** Occurrences in a window, for a calendar view or an ICS feed. */
export function occurrencesBetween(
  occurrences: EventOccurrence[],
  from: Date,
  to: Date,
): EventOccurrence[] {
  const window: Interval = { start: from, end: to };
  return occurrences
    .filter((o) => !o.cancelled)
    .filter((o) => overlaps({ start: new Date(o.start), end: new Date(o.end) }, window))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * An iCalendar feed for an event.
 *
 * Hand-built because the format is small and a dependency here would be
 * larger than the code. Line folding at 75 octets and CRLF endings are part of
 * the spec, not cosmetic — Outlook rejects feeds that get them wrong.
 */
export function toIcs(event: EventDefinition, occurrences: EventOccurrence[], origin: string): string {
  const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escape = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sidelio//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escape(event.title)}`,
  ];

  for (const occurrence of occurrences) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${occurrence.id}@${origin.replace(/^https?:\/\//, '')}`,
      `DTSTAMP:${stamp(new Date(occurrence.start).toISOString())}`,
      `DTSTART:${stamp(occurrence.start)}`,
      `DTEND:${stamp(occurrence.end)}`,
      `SUMMARY:${escape(event.title)}`,
      ...(event.description ? [`DESCRIPTION:${escape(event.description)}`] : []),
      ...(event.locationName || event.address
        ? [`LOCATION:${escape([event.locationName, event.address].filter(Boolean).join(', '))}`]
        : []),
      ...(occurrence.cancelled ? ['STATUS:CANCELLED'] : ['STATUS:CONFIRMED']),
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n');
}

/** Fold to 75 octets, continuing with a leading space, per RFC 5545. */
function foldIcsLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out: string[] = [];
  let current = '';
  for (const char of line) {
    if (Buffer.byteLength(current + char, 'utf8') > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = '';
    }
    current += char;
  }
  if (current) out.push(current);
  return out.join('\r\n ');
}

/** Local date of an occurrence, for grouping in a calendar UI. */
export function occurrenceLocalDate(occurrence: EventOccurrence, timezone: string): string {
  return localDateString(new Date(occurrence.start), timezone);
}
