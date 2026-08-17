import { describe, expect, it } from 'vitest';
import { asId, type SiteId } from '../src/core/ids.ts';
import { money } from '../src/commerce/money.ts';
import {
  canBook, expandRecurrence, generateSlots, localDateString, localMinuteOfDay,
  mergeIntervals, openWindowsOn, overlaps, resolveLocalTime, zoneOffsetMinutes,
  type Schedule, type SlotRules,
} from '../src/scheduling/availability.ts';
import {
  cancelBooking, createBooking, dueReminders, expandOccurrences, promoteFromWaitlist,
  register, rescheduleBooking, seatsRemaining, toIcs,
  type BookableService, type Booking, type EventDefinition, type Registration, type Resource,
} from '../src/scheduling/bookings.ts';

const SITE = asId<SiteId>('site_s');
const TZ = 'America/Halifax';
let seq = 0;
const makeId = (p: string) => `${p}_${String(++seq).padStart(4, '0')}`;

const schedule: Schedule = {
  timezone: TZ,
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday: weekday as 1, start: 9 * 60, end: 17 * 60 })),
};

const rules: SlotRules = { durationMinutes: 60, intervalMinutes: 30 };

/* ------------------------------------------------------------------ */

describe('timezones are wall clock, not fixed offsets', () => {
  it('tracks the offset across a DST transition', () => {
    expect(zoneOffsetMinutes(new Date('2026-03-07T17:00:00Z'), TZ)).toBe(-240);
    expect(zoneOffsetMinutes(new Date('2026-03-09T17:00:00Z'), TZ)).toBe(-180);
  });

  it('keeps a recurring 09:00 at 09:00 local across the change', () => {
    // "Every Tuesday at nine" is a wall-clock promise. A stored UTC offset
    // makes every appointment after the change an hour wrong.
    const before = resolveLocalTime('2026-03-07', 540, TZ);
    const after = resolveLocalTime('2026-03-09', 540, TZ);
    expect((before as { value: Date }).value.toISOString()).toBe('2026-03-07T13:00:00.000Z');
    expect((after as { value: Date }).value.toISOString()).toBe('2026-03-09T12:00:00.000Z');
    expect(localMinuteOfDay((after as { value: Date }).value, TZ)).toBe(540);
  });

  it('refuses a wall-clock time that does not exist', () => {
    // Silently shifting 02:30 to 03:00 gives the customer an appointment they
    // never chose.
    const r = resolveLocalTime('2026-03-08', 150, TZ);
    expect(r.ok).toBe(false);
    expect(String((r as { error: Error }).error.message)).toMatch(/clocks change/);
  });

  it('handles the repeated hour when clocks go back', () => {
    const r = resolveLocalTime('2026-11-01', 90, TZ);
    expect(r.ok).toBe(true);
    expect(localMinuteOfDay((r as { value: Date }).value, TZ)).toBe(90);
  });

  it('reads the local calendar date, not the UTC one', () => {
    // 00:30 local on the 2nd is 03:30 UTC — the naive answer is a day out.
    expect(localDateString(new Date('2026-07-02T03:30:00Z'), TZ)).toBe('2026-07-02');
    expect(localDateString(new Date('2026-07-02T01:30:00Z'), TZ)).toBe('2026-07-01');
  });
});

describe('intervals', () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 1, h, m));

  it('treats touching intervals as not overlapping', () => {
    // Back-to-back appointments are the normal case; calling them a clash
    // loses a sellable slot on every pair.
    expect(overlaps({ start: at(9), end: at(10) }, { start: at(10), end: at(11) })).toBe(false);
    expect(overlaps({ start: at(9), end: at(10, 1) }, { start: at(10), end: at(11) })).toBe(true);
  });

  it('merges overlapping and touching runs', () => {
    const merged = mergeIntervals([
      { start: at(9), end: at(10) },
      { start: at(10), end: at(11) },
      { start: at(13), end: at(14) },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('opening windows', () => {
  it('opens on a weekday and stays shut at the weekend', () => {
    expect(openWindowsOn(schedule, '2026-06-01')).toHaveLength(1); // Monday
    expect(openWindowsOn(schedule, '2026-06-06')).toHaveLength(0); // Saturday
  });

  it('lets an exception replace the weekly rules rather than add to them', () => {
    // "Closed, public holiday" means closed, not closed plus the usual hours.
    const withHoliday: Schedule = { ...schedule, exceptions: [{ date: '2026-06-01', windows: [] }] };
    expect(openWindowsOn(withHoliday, '2026-06-01')).toHaveLength(0);

    const shortDay: Schedule = { ...schedule, exceptions: [{ date: '2026-06-01', windows: [{ start: 600, end: 720 }] }] };
    const windows = openWindowsOn(shortDay, '2026-06-01');
    expect(windows).toHaveLength(1);
    expect(localMinuteOfDay(windows[0]!.start, TZ)).toBe(600);
  });
});

describe('slot generation', () => {
  const monday = ['2026-06-01'];

  it('steps by the interval inside opening hours', () => {
    const slots = generateSlots({ schedule, rules, dates: monday, now: new Date('2026-05-01T00:00:00Z') });
    // 09:00 to 17:00, hour-long slots every 30 minutes: last start is 16:00.
    expect(slots).toHaveLength(15);
    expect(localMinuteOfDay(slots[0]!.start, TZ)).toBe(540);
    expect(localMinuteOfDay(slots[slots.length - 1]!.start, TZ)).toBe(960);
  });

  it('removes slots that overlap a commitment, not just ones that match it', () => {
    const busyStart = (resolveLocalTime('2026-06-01', 600, TZ) as { value: Date }).value;
    const slots = generateSlots({
      schedule, rules, dates: monday, now: new Date('2026-05-01T00:00:00Z'),
      busy: [{ start: busyStart, end: new Date(busyStart.getTime() + 3600000) }],
    });
    const starts = slots.map((s) => localMinuteOfDay(s.start, TZ));
    // A 10:00–11:00 commitment blocks the 09:30, 10:00 and 10:30 starts.
    expect(starts).not.toContain(570);
    expect(starts).not.toContain(600);
    expect(starts).not.toContain(630);
    expect(starts).toContain(540);
    expect(starts).toContain(660);
  });

  it('clears the neighbouring appointment buffers, not only its own', () => {
    const busyStart = (resolveLocalTime('2026-06-01', 660, TZ) as { value: Date }).value;
    const buffered: SlotRules = { ...rules, bufferAfterMinutes: 30 };
    const slots = generateSlots({
      schedule, rules: buffered, dates: monday, now: new Date('2026-05-01T00:00:00Z'),
      busy: [{ start: busyStart, end: new Date(busyStart.getTime() + 3600000) }],
    });
    const starts = slots.map((s) => localMinuteOfDay(s.start, TZ));
    // 11:00–12:00 busy; a 10:00 slot ends at 11:00 but needs 30 minutes after.
    expect(starts).not.toContain(600);
    expect(starts).not.toContain(630);
  });

  it('keeps a slot buffer inside opening hours so nothing runs past closing', () => {
    const buffered: SlotRules = { ...rules, bufferAfterMinutes: 30 };
    const slots = generateSlots({ schedule, rules: buffered, dates: monday, now: new Date('2026-05-01T00:00:00Z') });
    expect(Math.max(...slots.map((s) => localMinuteOfDay(s.start, TZ)))).toBe(930); // 15:30 + 60 + 30 = 17:00
  });

  it('respects notice and horizon', () => {
    const now = (resolveLocalTime('2026-06-01', 540, TZ) as { value: Date }).value;
    const slots = generateSlots({
      schedule, rules: { ...rules, minimumNoticeMinutes: 120 }, dates: monday, now,
    });
    expect(Math.min(...slots.map((s) => localMinuteOfDay(s.start, TZ)))).toBe(660);

    const far = generateSlots({
      schedule, rules: { ...rules, maximumAdvanceDays: 1 },
      dates: ['2026-06-01', '2026-06-30'], now: new Date('2026-05-31T12:00:00Z'),
    });
    expect(far.every((s) => s.start < new Date('2026-06-02T00:00:00Z'))).toBe(true);
  });

  it('counts capacity by overlap so two chairs sell two and refuse a third', () => {
    const busyStart = (resolveLocalTime('2026-06-01', 600, TZ) as { value: Date }).value;
    const busy = { start: busyStart, end: new Date(busyStart.getTime() + 3600000) };
    const two = generateSlots({
      schedule, rules: { ...rules, capacity: 2 }, dates: monday,
      now: new Date('2026-05-01T00:00:00Z'), busy: [busy],
    });
    const ten = two.find((s) => localMinuteOfDay(s.start, TZ) === 600);
    expect(ten?.remaining).toBe(1);

    const full = generateSlots({
      schedule, rules: { ...rules, capacity: 2 }, dates: monday,
      now: new Date('2026-05-01T00:00:00Z'), busy: [busy, busy],
    });
    expect(full.some((s) => localMinuteOfDay(s.start, TZ) === 600)).toBe(false);
  });

  it('refuses a zero interval rather than looping forever', () => {
    expect(() => generateSlots({
      schedule, rules: { ...rules, intervalMinutes: 0 }, dates: monday, now: new Date(),
    })).toThrow(/never terminates/);
  });
});

/* ------------------------------------------------------------------ */

const service: BookableService = {
  id: 'svc_1', siteId: SITE, name: 'Roof inspection', durationMinutes: 60,
  resourceIds: [], slotRules: rules, active: true,
};

const resource: Resource = {
  id: 'res_1', siteId: SITE, name: 'Dan', kind: 'person', schedule, capacity: 1, active: true,
};

const NOW = new Date('2026-05-01T12:00:00Z');
const slotAt = (minute: number, date = '2026-06-01') =>
  (resolveLocalTime(date, minute, TZ) as { value: Date }).value;

const booking = (over: Partial<Booking> = {}): Booking => ({
  id: 'bkg_x', siteId: SITE, serviceId: 'svc_1', resourceId: 'res_1',
  customerName: 'A', customerEmail: 'a@b.co',
  start: slotAt(600).toISOString(), end: slotAt(660).toISOString(),
  status: 'confirmed', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
});

describe('bookings', () => {
  const make = (over: Record<string, unknown> = {}) => createBooking({
    siteId: SITE, service, resource, start: slotAt(540),
    customerName: 'Sam', customerEmail: 'sam@example.com',
    existing: [], now: NOW, makeId, ...over,
  });

  it('creates a booking inside opening hours', () => {
    const r = make();
    expect(r.ok).toBe(true);
    expect((r as { value: Booking }).value.status).toBe('confirmed');
  });

  it('re-checks availability rather than trusting the slot sent back', () => {
    // The gap between rendering a slot list and pressing confirm is where
    // double bookings are made.
    const r = make({ existing: [booking({ start: slotAt(540).toISOString(), end: slotAt(600).toISOString() })] });
    expect(r.ok).toBe(false);
    expect(String((r as { error: Error }).error.message)).toMatch(/just been taken/);
  });

  it('refuses a time outside opening hours', () => {
    expect(make({ start: slotAt(480) }).ok).toBe(false);
  });

  it('ignores cancelled bookings when checking the resource', () => {
    const r = make({
      existing: [booking({ status: 'cancelled', start: slotAt(540).toISOString(), end: slotAt(600).toISOString() })],
    });
    expect(r.ok).toBe(true);
  });

  it('leaves a deposit-taking service pending until it is paid', () => {
    const deposit = { ...service, depositAmount: money(5000, 'CAD') };
    const r = make({ service: deposit });
    expect((r as { value: Booking }).value.status).toBe('pending');
  });

  it('enforces required intake questions', () => {
    const withIntake = {
      ...service,
      intakeFields: [{ key: 'roof', label: 'Roof type', required: true, type: 'text' as const }],
    };
    expect(make({ service: withIntake }).ok).toBe(false);
    expect(make({ service: withIntake, answers: { roof: 'asphalt' } }).ok).toBe(true);
  });

  it('refuses a resource that does not provide the service', () => {
    expect(make({ service: { ...service, resourceIds: ['other'] } }).ok).toBe(false);
  });

  it('honours a cancellation window for customers but not for staff', () => {
    const b = booking({ start: slotAt(600).toISOString() });
    const late = new Date(Date.parse(b.start) - 3600000);
    expect(cancelBooking(b, { reason: 'x', now: late, policyHours: 24 }).ok).toBe(false);
    expect(cancelBooking(b, { reason: 'x', now: late, policyHours: 24, byStaff: true }).ok).toBe(true);
  });

  it('reschedules without colliding with itself', () => {
    // Excluding the booking's own interval is what stops every move failing.
    const b = booking();
    const r = rescheduleBooking(b, slotAt(780), { service, resource, existing: [b], now: NOW });
    expect(r.ok).toBe(true);
  });

  it('sends each reminder once', () => {
    const soon = booking({ start: new Date(NOW.getTime() + 3600000).toISOString() });
    expect(dueReminders([soon], 24, NOW)).toHaveLength(1);
    expect(dueReminders([{ ...soon, remindedAt: NOW.toISOString() }], 24, NOW)).toHaveLength(0);
  });

  it('never double-books across a randomised sweep', () => {
    let held: Booking[] = [];
    let made = 0;
    for (let i = 0; i < 200; i++) {
      const minute = 540 + (i * 30) % 480;
      const r = createBooking({
        siteId: SITE, service, resource, start: slotAt(minute),
        customerName: 'X', customerEmail: 'x@y.co', existing: held, now: NOW, makeId,
      });
      if (r.ok) { held = [...held, r.value]; made++; }
    }
    expect(made).toBeGreaterThan(0);
    for (let i = 0; i < held.length; i++) {
      for (let j = i + 1; j < held.length; j++) {
        const a = held[i]!, b = held[j]!;
        expect(overlaps(
          { start: new Date(a.start), end: new Date(a.end) },
          { start: new Date(b.start), end: new Date(b.end) },
        ), `${a.start} overlaps ${b.start}`).toBe(false);
      }
    }
  });
});

/* ------------------------------------------------------------------ */

describe('recurrence', () => {
  it('expands weekly dates', () => {
    const r = expandRecurrence('2026-06-01', { frequency: 'weekly', interval: 1, weekdays: [1] }, TZ, 10);
    expect((r as { value: string[] }).value.slice(0, 3)).toEqual(['2026-06-01', '2026-06-08', '2026-06-15']);
  });

  it('stops at a count and skips exceptions', () => {
    const r = expandRecurrence('2026-06-01',
      { frequency: 'daily', interval: 1, count: 3, exceptions: ['2026-06-02'] }, TZ);
    expect((r as { value: string[] }).value).toEqual(['2026-06-01', '2026-06-03', '2026-06-04']);
  });

  it('stops at an until date', () => {
    const r = expandRecurrence('2026-06-01', { frequency: 'daily', interval: 1, until: '2026-06-03' }, TZ);
    expect((r as { value: string[] }).value).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });

  it('refuses a zero interval rather than looping', () => {
    expect(expandRecurrence('2026-06-01', { frequency: 'daily', interval: 0 }, TZ).ok).toBe(false);
  });
});

const event: EventDefinition = {
  id: 'evt_1', siteId: SITE, title: 'Roof care workshop', timezone: TZ,
  startDate: '2026-06-01', startMinute: 19 * 60, durationMinutes: 90,
  capacity: 10, waitlistEnabled: false, status: 'published',
  ticketTypes: [{ id: 'tt_1', name: 'General', price: money(2000, 'CAD') }],
};

describe('events', () => {
  it('keeps an evening class at the same local time across DST', () => {
    const recurring = { ...event, startDate: '2026-03-01', recurrence: { frequency: 'weekly' as const, interval: 1, count: 3 } };
    const r = expandOccurrences(recurring);
    const times = (r as { value: { start: string }[] }).value
      .map((o) => localMinuteOfDay(new Date(o.start), TZ));
    expect(new Set(times)).toEqual(new Set([19 * 60]));
  });

  it('counts capacity and refuses when full', () => {
    const occurrence = (expandOccurrences(event) as { value: { id: string; start: string; capacity?: number }[] }).value[0]!;
    const existing: Registration[] = [{
      id: 'r1', siteId: SITE, eventId: 'evt_1', occurrenceId: occurrence.id, ticketTypeId: 'tt_1',
      name: 'A', email: 'a@b.co', quantity: 9, status: 'confirmed', createdAt: NOW.toISOString(),
    }];
    expect(seatsRemaining(occurrence, existing)).toBe(1);

    const tooMany = register({
      siteId: SITE, event, occurrence, ticketTypeId: 'tt_1', name: 'B', email: 'b@c.co',
      quantity: 2, existing, now: NOW, makeId,
    });
    // Partially confirming would leave someone who paid for two with one.
    expect(tooMany.ok).toBe(false);
    expect(String((tooMany as { error: Error }).error.message)).toMatch(/1 place remains/);
  });

  it('waitlists instead of failing when the event allows it', () => {
    const waitlisted = { ...event, waitlistEnabled: true, capacity: 1 };
    const occurrence = (expandOccurrences(waitlisted) as { value: { id: string }[] }).value[0]!;
    const existing: Registration[] = [{
      id: 'r1', siteId: SITE, eventId: 'evt_1', occurrenceId: occurrence.id, ticketTypeId: 'tt_1',
      name: 'A', email: 'a@b.co', quantity: 1, status: 'confirmed', createdAt: NOW.toISOString(),
    }];
    const r = register({
      siteId: SITE, event: waitlisted, occurrence: { ...occurrence, capacity: 1 },
      ticketTypeId: 'tt_1', name: 'B', email: 'b@c.co', quantity: 1, existing, now: NOW, makeId,
    });
    expect((r as { value: Registration }).value.status).toBe('waitlisted');
  });

  it('promotes whole waitlist entries oldest first, never splitting a party', () => {
    const occurrence = { id: 'occ', eventId: 'evt_1', date: '2026-06-01', start: '2026-06-01T22:00:00Z', end: '2026-06-01T23:30:00Z', capacity: 3 };
    const registrations: Registration[] = [
      { id: 'w1', siteId: SITE, eventId: 'evt_1', occurrenceId: 'occ', ticketTypeId: 'tt_1', name: 'Party of 4', email: 'a@b.co', quantity: 4, status: 'waitlisted', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'w2', siteId: SITE, eventId: 'evt_1', occurrenceId: 'occ', ticketTypeId: 'tt_1', name: 'Pair', email: 'c@d.co', quantity: 2, status: 'waitlisted', createdAt: '2026-05-02T00:00:00Z' },
    ];
    const { promoted } = promoteFromWaitlist(occurrence, registrations, NOW);
    // The party of four does not fit in three seats and is not split.
    expect(promoted.map((p) => p.id)).toEqual(['w2']);
  });

  it('refuses registration for an event that has started', () => {
    const occurrence = (expandOccurrences(event) as { value: { id: string; start: string }[] }).value[0]!;
    const after = new Date(Date.parse(occurrence.start) + 60000);
    const r = register({
      siteId: SITE, event, occurrence, ticketTypeId: 'tt_1', name: 'A', email: 'a@b.co',
      quantity: 1, existing: [], now: after, makeId,
    });
    expect(r.ok).toBe(false);
  });

  it('honours ticket sales windows and per-order limits', () => {
    const occurrence = (expandOccurrences(event) as { value: { id: string }[] }).value[0]!;
    const limited = {
      ...event,
      ticketTypes: [{ id: 'tt_1', name: 'General', price: money(2000, 'CAD'), maxPerOrder: 2, salesEnd: '2026-04-01T00:00:00Z' }],
    };
    const base = { siteId: SITE, event: limited, occurrence, ticketTypeId: 'tt_1', name: 'A', email: 'a@b.co', existing: [], now: NOW, makeId };
    expect(register({ ...base, quantity: 3 }).ok).toBe(false);
    expect(register({ ...base, quantity: 1 }).ok).toBe(false); // sales closed
  });
});

describe('ics feed', () => {
  it('emits CRLF endings and folds long lines', () => {
    // Outlook rejects feeds that get folding or line endings wrong.
    const long = { ...event, title: 'A'.repeat(200) };
    const occurrences = (expandOccurrences(long) as { value: never[] }).value;
    const ics = toIcs(long, occurrences, 'https://example.com');
    expect(ics).toContain('\r\n');
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
  });

  it('escapes characters that would break the format', () => {
    const ics = toIcs({ ...event, description: 'Bring; a ladder, please\nand boots' }, [], 'https://x.com');
    expect(ics).not.toMatch(/DESCRIPTION:[^\\]*;/);
  });
});

describe('canBook is the single gate', () => {
  it('rejects a zero-length booking', () => {
    const t = slotAt(540);
    expect(canBook({ start: t, end: t }, { schedule, rules, now: NOW }).ok).toBe(false);
  });
});
