/**
 * Availability.
 *
 * One engine serves both bookings (a slot with a resource and a duration) and
 * events (a fixed occurrence with capacity), because the hard part is the same
 * for both: turning opening rules, exceptions, existing commitments and
 * timezone reality into a list of times that can genuinely be sold.
 *
 * The parts that are easy to get wrong, and are handled explicitly here:
 *
 *  - **Daylight saving.** "Every Tuesday at 09:00" is a wall-clock promise. On
 *    the Tuesday the clocks change, the UTC instant moves by an hour. Storing
 *    a fixed UTC offset makes every appointment after March wrong, so rules
 *    are stored as local wall time plus an IANA zone and resolved per day.
 *  - **Overlap, not equality.** A slot is unavailable if it *intersects* a
 *    commitment, not if it starts at the same minute. Equality checks are why
 *    double bookings survive testing.
 *  - **Buffers are asymmetric.** Fifteen minutes to travel after a job is not
 *    the same as fifteen minutes to prepare before one, and a slot must clear
 *    the *neighbouring* appointment's buffers as well as its own.
 *  - **Lead time and horizon.** A slot two minutes from now is technically
 *    free and commercially useless.
 */

import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';

/** Minutes from local midnight. 540 is 09:00. */
export type MinuteOfDay = number;

/** 0 = Sunday, matching Date.getUTCDay. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface OpeningRule {
  weekday: Weekday;
  start: MinuteOfDay;
  end: MinuteOfDay;
}

export interface DateException {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Empty windows mean closed all day. */
  windows: { start: MinuteOfDay; end: MinuteOfDay }[];
  reason?: string;
}

export interface Interval {
  /** Inclusive start, exclusive end. Both are absolute instants. */
  start: Date;
  end: Date;
}

export interface Schedule {
  /** IANA zone the wall-clock rules are written in. */
  timezone: string;
  rules: OpeningRule[];
  exceptions?: DateException[];
}

export interface SlotRules {
  /** Length of the appointment itself. */
  durationMinutes: number;
  /** Slot start times step by this. 15 gives :00 :15 :30 :45. */
  intervalMinutes: number;
  /** Free time required before the appointment. */
  bufferBeforeMinutes?: number;
  /** Free time required after it. */
  bufferAfterMinutes?: number;
  /** Nothing bookable sooner than this from now. */
  minimumNoticeMinutes?: number;
  /** Nothing bookable further out than this. */
  maximumAdvanceDays?: number;
  /** How many appointments the resource can run at once. */
  capacity?: number;
}

/* ------------------------------------------------------------------ */
/* Timezone handling                                                   */
/* ------------------------------------------------------------------ */

/**
 * Offset in minutes for a zone at a given instant.
 *
 * Derived from Intl rather than a table, so it stays correct as zones change
 * their rules — several countries have altered or abolished DST inside the
 * last few years, and a bundled table is wrong the day that happens.
 */
export function zoneOffsetMinutes(instant: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  // Intl renders hour 24 for midnight in some engines; normalise before use.
  const hour = parts['hour'] === '24' ? '00' : parts['hour'];
  const asUtc = Date.UTC(
    Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']),
    Number(hour), Number(parts['minute']), Number(parts['second']),
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** Local calendar date in a zone, as YYYY-MM-DD. */
export function localDateString(instant: Date, timezone: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return dtf.format(instant);
}

export function localWeekday(instant: Date, timezone: string): Weekday {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(instant);
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  return (index < 0 ? 0 : index) as Weekday;
}

/**
 * Resolve a local wall-clock time on a calendar date to an absolute instant.
 *
 * Two passes: guess using the offset at noon on that date, then re-read the
 * offset at the guessed instant and correct. One pass is wrong for times near
 * a transition, which is exactly when this matters.
 *
 * Returns an error for wall-clock times that do not exist — the hour skipped
 * when clocks spring forward. Silently shifting such a booking to 03:00 gives
 * the customer an appointment they never chose.
 */
export function resolveLocalTime(
  date: string,
  minuteOfDay: MinuteOfDay,
  timezone: string,
): Result<Date> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return fail(err('VALIDATION_FAILED', `"${date}" is not a YYYY-MM-DD date`));
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];

  const naive = Date.UTC(y, m - 1, d, 0, 0, 0) + minuteOfDay * 60000;
  const noonGuess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const firstOffset = zoneOffsetMinutes(noonGuess, timezone);
  const firstGuess = new Date(naive - firstOffset * 60000);
  const secondOffset = zoneOffsetMinutes(firstGuess, timezone);
  const resolved = new Date(naive - secondOffset * 60000);

  // Round-trip: if reading the local time back does not give what we asked
  // for, the wall-clock time does not exist on this date.
  const backDate = localDateString(resolved, timezone);
  const backMinutes = localMinuteOfDay(resolved, timezone);
  if (backDate !== date || backMinutes !== minuteOfDay % 1440) {
    if (minuteOfDay >= 1440) return ok(resolved); // deliberately past midnight
    return fail(err('VALIDATION_FAILED',
      `${date} ${formatMinute(minuteOfDay)} does not exist in ${timezone} — the clocks change that day`));
  }
  return ok(resolved);
}

export function localMinuteOfDay(instant: Date, timezone: string): MinuteOfDay {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const hour = parts['hour'] === '24' ? 0 : Number(parts['hour']);
  return hour * 60 + Number(parts['minute']);
}

export function formatMinute(minute: MinuteOfDay): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Intervals                                                           */
/* ------------------------------------------------------------------ */

/**
 * Do two intervals overlap?
 *
 * Half-open: an appointment ending at 10:00 and one starting at 10:00 do not
 * overlap. Treating the boundary as a clash loses a sellable slot on every
 * back-to-back pair.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start.getTime() <= inner.start.getTime() && inner.end.getTime() <= outer.end.getTime();
}

/** Merge overlapping and touching intervals into the fewest that cover them. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [{ ...sorted[0]! }];
  for (const current of sorted.slice(1)) {
    const last = out[out.length - 1]!;
    if (current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) last.end = current.end;
    } else {
      out.push({ ...current });
    }
  }
  return out;
}

/** Grow an interval by a buffer on each side. */
export function padInterval(interval: Interval, beforeMinutes: number, afterMinutes: number): Interval {
  return {
    start: new Date(interval.start.getTime() - beforeMinutes * 60000),
    end: new Date(interval.end.getTime() + afterMinutes * 60000),
  };
}

/* ------------------------------------------------------------------ */
/* Opening windows                                                     */
/* ------------------------------------------------------------------ */

/**
 * The absolute intervals a schedule is open for on one local date.
 *
 * An exception for the date replaces the weekly rules entirely rather than
 * adding to them — a merchant setting "closed, public holiday" means closed,
 * not closed-plus-the-usual-hours.
 */
export function openWindowsOn(schedule: Schedule, date: string): Interval[] {
  const exception = schedule.exceptions?.find((e) => e.date === date);
  const windows = exception
    ? exception.windows
    : rulesForDate(schedule, date);

  const out: Interval[] = [];
  for (const window of windows) {
    if (window.end <= window.start) continue;
    const start = resolveLocalTime(date, window.start, schedule.timezone);
    const end = resolveLocalTime(date, window.end, schedule.timezone);
    if (!start.ok || !end.ok) continue;
    out.push({ start: start.value, end: end.value });
  }
  return mergeIntervals(out);
}

function rulesForDate(schedule: Schedule, date: string): { start: MinuteOfDay; end: MinuteOfDay }[] {
  const noon = resolveLocalTime(date, 720, schedule.timezone);
  if (!noon.ok) return [];
  const weekday = localWeekday(noon.value, schedule.timezone);
  return schedule.rules.filter((r) => r.weekday === weekday).map((r) => ({ start: r.start, end: r.end }));
}

/* ------------------------------------------------------------------ */
/* Slot generation                                                     */
/* ------------------------------------------------------------------ */

export interface Slot {
  start: Date;
  end: Date;
  /** How many more bookings this slot can still take. */
  remaining: number;
}

export interface SlotQuery {
  schedule: Schedule;
  rules: SlotRules;
  /** Local dates to generate for. */
  dates: string[];
  /** Existing commitments, already in absolute time. */
  busy?: Interval[];
  /** Buffers of the neighbouring appointments, if they differ from the rules. */
  busyBufferBeforeMinutes?: number;
  busyBufferAfterMinutes?: number;
  now: Date;
}

/**
 * Every slot that can genuinely be sold.
 *
 * A slot must sit inside an opening window, clear its own buffers and those of
 * every neighbouring commitment, respect notice and horizon, and have capacity
 * left. Capacity is counted by overlap rather than by exact match, so a
 * two-chair salon correctly sells two overlapping half-hours and refuses the
 * third.
 */
export function generateSlots(query: SlotQuery): Slot[] {
  const { schedule, rules, now } = query;
  if (rules.durationMinutes <= 0) {
    throw err('VALIDATION_FAILED', 'a bookable slot needs a positive duration');
  }
  if (rules.intervalMinutes <= 0) {
    throw err('VALIDATION_FAILED', 'slot interval must be positive, or generation never terminates');
  }

  const capacity = rules.capacity ?? 1;
  const bufferBefore = rules.bufferBeforeMinutes ?? 0;
  const bufferAfter = rules.bufferAfterMinutes ?? 0;
  const busyBefore = query.busyBufferBeforeMinutes ?? bufferBefore;
  const busyAfter = query.busyBufferAfterMinutes ?? bufferAfter;

  const earliest = new Date(now.getTime() + (rules.minimumNoticeMinutes ?? 0) * 60000);
  const latest = rules.maximumAdvanceDays !== undefined
    ? new Date(now.getTime() + rules.maximumAdvanceDays * 86400000)
    : undefined;

  // Each commitment is padded by the buffers that must surround it, so a slot
  // has to clear the neighbour's travel time as well as its own preparation.
  const blocked = (query.busy ?? []).map((b) => padInterval(b, busyAfter, busyBefore));

  const slots: Slot[] = [];
  for (const date of [...query.dates].sort()) {
    for (const window of openWindowsOn(schedule, date)) {
      let cursor = window.start.getTime();
      const step = rules.intervalMinutes * 60000;
      const length = rules.durationMinutes * 60000;

      while (cursor + length <= window.end.getTime()) {
        const slot: Interval = { start: new Date(cursor), end: new Date(cursor + length) };
        cursor += step;

        if (slot.start.getTime() < earliest.getTime()) continue;
        if (latest && slot.start.getTime() > latest.getTime()) continue;

        // The slot's own buffers must also fall inside the opening window,
        // or the last appointment of the day runs past closing time.
        const padded = padInterval(slot, bufferBefore, bufferAfter);
        if (!contains(window, padded)) continue;

        const clashes = blocked.filter((b) => overlaps(padded, b)).length;
        if (clashes >= capacity) continue;

        slots.push({ start: slot.start, end: slot.end, remaining: capacity - clashes });
      }
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Can this exact interval still be taken?
 *
 * Checked again at write time, not just when the list was rendered. The gap
 * between a customer seeing a slot and confirming it is where double bookings
 * are made, and the only defence is re-checking against current state.
 */
export function canBook(
  wanted: Interval,
  query: Omit<SlotQuery, 'dates'> & { dates?: string[] },
): Result<true> {
  const { schedule, rules, now } = query;
  const capacity = rules.capacity ?? 1;
  const bufferBefore = rules.bufferBeforeMinutes ?? 0;
  const bufferAfter = rules.bufferAfterMinutes ?? 0;

  if (wanted.end.getTime() <= wanted.start.getTime()) {
    return fail(err('VALIDATION_FAILED', 'a booking must end after it starts'));
  }
  const noticeCutoff = new Date(now.getTime() + (rules.minimumNoticeMinutes ?? 0) * 60000);
  if (wanted.start.getTime() < noticeCutoff.getTime()) {
    return fail(err('CONFLICT', 'that time is too soon to book'));
  }
  if (rules.maximumAdvanceDays !== undefined
    && wanted.start.getTime() > now.getTime() + rules.maximumAdvanceDays * 86400000) {
    return fail(err('CONFLICT', 'that date is further ahead than bookings are open'));
  }

  const date = localDateString(wanted.start, schedule.timezone);
  const windows = openWindowsOn(schedule, date);
  const padded = padInterval(wanted, bufferBefore, bufferAfter);
  if (!windows.some((w) => contains(w, padded))) {
    return fail(err('CONFLICT', 'that time falls outside opening hours'));
  }

  const busyBefore = query.busyBufferBeforeMinutes ?? bufferBefore;
  const busyAfter = query.busyBufferAfterMinutes ?? bufferAfter;
  const clashes = (query.busy ?? [])
    .map((b) => padInterval(b, busyAfter, busyBefore))
    .filter((b) => overlaps(padded, b)).length;
  if (clashes >= capacity) {
    return fail(err('CONFLICT', 'that time has just been taken'));
  }

  return ok(true);
}

/* ------------------------------------------------------------------ */
/* Recurrence                                                          */
/* ------------------------------------------------------------------ */

export interface Recurrence {
  frequency: 'daily' | 'weekly' | 'monthly';
  /** Every N periods. */
  interval: number;
  /** Weekly only: which days. Empty means the start's own weekday. */
  weekdays?: Weekday[];
  /** Stop after this many occurrences. */
  count?: number;
  /** Stop after this local date, inclusive. */
  until?: string;
  /** Local dates to skip — a cancelled instance of a series. */
  exceptions?: string[];
}

/**
 * Expand a recurrence into local dates.
 *
 * Dates rather than instants, because the wall-clock time is resolved per
 * occurrence afterwards. A weekly 09:00 series crossing a DST boundary stays
 * at 09:00 local, which is what "every Tuesday morning" means to everyone
 * except a computer.
 */
export function expandRecurrence(
  startDate: string,
  recurrence: Recurrence,
  timezone: string,
  limit = 500,
): Result<string[]> {
  if (recurrence.interval <= 0 || !Number.isInteger(recurrence.interval)) {
    return fail(err('VALIDATION_FAILED', 'recurrence interval must be a positive whole number'));
  }
  const first = resolveLocalTime(startDate, 720, timezone);
  if (!first.ok) return fail(first.error);

  const exceptions = new Set(recurrence.exceptions ?? []);
  const wanted = recurrence.weekdays?.length ? new Set(recurrence.weekdays) : undefined;
  const out: string[] = [];
  const max = recurrence.count ?? limit;

  const cursor = new Date(first.value.getTime());
  let periods = 0;
  let guard = 0;

  while (out.length < max && guard < limit * 8) {
    guard++;
    const date = localDateString(cursor, timezone);
    if (recurrence.until && date > recurrence.until) break;

    const weekdayOk = !wanted || wanted.has(localWeekday(cursor, timezone));
    const periodOk = recurrence.frequency === 'weekly'
      ? true // weekly interval is handled by jumping whole weeks below
      : periods % recurrence.interval === 0;

    if (weekdayOk && periodOk && !exceptions.has(date)) out.push(date);

    if (recurrence.frequency === 'daily') {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      periods++;
    } else if (recurrence.frequency === 'weekly') {
      const before = localWeekday(cursor, timezone);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      // Jump the remaining weeks once the week rolls over.
      if (before === 6 && recurrence.interval > 1) {
        cursor.setUTCDate(cursor.getUTCDate() + 7 * (recurrence.interval - 1));
      }
    } else {
      cursor.setUTCMonth(cursor.getUTCMonth() + recurrence.interval);
      periods++;
    }
  }

  return ok(out);
}
