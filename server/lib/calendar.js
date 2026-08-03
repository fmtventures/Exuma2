'use strict';

const { addDays } = require('./dates');

/**
 * Google Calendar is the booking database.
 *
 * That is a deliberate choice for a 40-site campground: the office already
 * lives in a calendar, and this way a booking taken over the phone and a
 * booking taken online are the same kind of object. Anyone in the family can
 * see the season fill up from their phone, and blocking a site off needs no
 * software at all — just a calendar event.
 *
 * Each booking is one all-day event. Google treats all-day `end.date` as
 * exclusive, which is exactly how departure dates work, so a stay maps across
 * without adjustment. Machine-readable detail lives in extendedProperties;
 * the summary and description are written for a human reading their phone.
 */

const APP = 'ape';

/**
 * Owner-created blocks, written straight into the calendar from a phone:
 *   "BLOCK 14"              one numbered site
 *   "BLOCK 14, 15, 16"      several
 *   "BLOCK tent x2"         two of a type, no particular square
 *   "BLOCK all — road work" the whole campground
 */
function parseBlock(summary, siteTypes, siteIndex) {
  if (!summary) return null;
  const text = String(summary).trim();
  if (!/^block\b/i.test(text)) return null;

  const rest = text.slice(5).trim().toLowerCase();

  if (siteIndex && siteIndex.size) {
    const numbers = (rest.match(/\d+/g) || []).filter((n) => siteIndex.has(n));
    // "tent x2" also contains a digit; only treat digits as site numbers when
    // they are not the multiplier of a type block.
    const isTypeBlock = siteTypes.some((t) => rest.includes(t.id) || rest.includes(t.name.toLowerCase()));
    if (numbers.length && !isTypeBlock) {
      return numbers.map((number) => ({
        siteTypeId: siteIndex.get(number).typeId,
        siteNumber: number,
        units: 1,
      }));
    }
  }
  const unitsMatch = rest.match(/\bx\s*(\d+)\b/);
  const units = unitsMatch ? Math.max(1, parseInt(unitsMatch[1], 10)) : 1;

  if (/^all\b/.test(rest)) {
    return siteTypes.map((t) => ({ siteTypeId: t.id, units: t.inventory || 1 }));
  }
  const type = siteTypes.find(
    (t) => rest.includes(t.id) || rest.includes(t.name.toLowerCase())
  );
  return type ? [{ siteTypeId: type.id, units }] : null;
}

function eventToRecords(event, siteTypes, siteIndex) {
  const props = (event.extendedProperties && event.extendedProperties.private) || {};
  const arrival = event.start && event.start.date;
  const departure = event.end && event.end.date;
  if (!arrival || !departure) return []; // timed events are somebody's meeting, not a stay

  if (props.app === APP && props.siteTypeId) {
    if (props.state === 'cancelled') return []; // kept for the record, but back on sale
    return [{
      eventId: event.id,
      siteTypeId: props.siteTypeId,
      arrival,
      departure,
      units: Number(props.units || 1),
      siteNumber: props.siteNumber || null,
      state: props.state || 'confirmed',
      holdExpires: props.holdExpires || null,
      sessionId: props.sessionId || null,
      ref: props.ref || null,
      name: props.name || null,
      email: props.email || null,
    }];
  }

  const blocks = parseBlock(event.summary, siteTypes, siteIndex);
  if (!blocks) return [];
  return blocks.map((b) => ({
    eventId: event.id,
    siteTypeId: b.siteTypeId,
    siteNumber: b.siteNumber || null,
    arrival,
    departure,
    units: b.units,
    state: 'block',
    holdExpires: null,
  }));
}

function bookingSummary(record, state) {
  const who = record.name || 'Guest';
  const label = state === 'hold' ? 'HOLD' : 'Booked';
  const where = record.siteNumber ? `Site ${record.siteNumber}` : record.siteTypeName;
  return `${label} · ${where} · ${who}`;
}

function bookingDescription(record, quote) {
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  return [
    `${record.siteNumber ? `Site ${record.siteNumber} · ` : ''}${record.siteTypeName} — ${quote.nights} night${quote.nights === 1 ? '' : 's'}, ${record.guests} guest${record.guests === 1 ? '' : 's'}`,
    `Reference: ${record.ref}`,
    '',
    `Name:  ${record.name}`,
    `Email: ${record.email}`,
    `Phone: ${record.phone || '—'}`,
    '',
    `Total: ${money(quote.total)} (incl. ${quote.taxLabel} ${money(quote.tax)})`,
    `Paid online: ${money(quote.deposit)}`,
    `Balance on arrival: ${money(quote.balance)}`,
    record.notes ? `\nNotes: ${record.notes}` : '',
  ].join('\n');
}

/** extendedProperties values must be strings, and Google caps them at 1024 chars. */
function props(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v).slice(0, 1024);
  }
  return out;
}

class GoogleCalendarStore {
  constructor({ calendarId, auth, google }) {
    this.calendarId = calendarId;
    this.api = google.calendar({ version: 'v3', auth });
  }

  async listEvents(from, to) {
    const items = [];
    let pageToken;
    do {
      const res = await this.api.events.list({
        calendarId: this.calendarId,
        timeMin: new Date(`${from}T00:00:00Z`).toISOString(),
        timeMax: new Date(`${addDays(to, 1)}T00:00:00Z`).toISOString(),
        singleEvents: true,
        showDeleted: false,
        maxResults: 2500,
        pageToken,
      });
      items.push(...(res.data.items || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return items;
  }

  async listOccupancy(from, to, siteTypes, siteIndex) {
    const events = await this.listEvents(from, to);
    return events.flatMap((e) => eventToRecords(e, siteTypes, siteIndex));
  }

  async createHold(record, quote, holdExpires) {
    const res = await this.api.events.insert({
      calendarId: this.calendarId,
      requestBody: {
        summary: bookingSummary(record, 'hold'),
        description: bookingDescription(record, quote),
        start: { date: quote.arrival },
        end: { date: quote.departure },
        transparency: 'transparent',
        status: 'tentative',
        extendedProperties: {
          private: props({
            app: APP,
            state: 'hold',
            siteTypeId: quote.siteTypeId,
            siteNumber: record.siteNumber,
            units: 1,
            guests: record.guests,
            name: record.name,
            email: record.email,
            phone: record.phone,
            ref: record.ref,
            holdExpires,
            totalCents: quote.total,
            depositCents: quote.deposit,
          }),
        },
      },
    });
    return res.data;
  }

  async attachSession(eventId, sessionId) {
    await this.api.events.patch({
      calendarId: this.calendarId,
      eventId,
      requestBody: { extendedProperties: { private: props({ sessionId }) } },
    });
  }

  async confirm(eventId, { paymentRef, paidCents }) {
    const { data: event } = await this.api.events.get({ calendarId: this.calendarId, eventId });
    const existing = (event.extendedProperties && event.extendedProperties.private) || {};
    if (existing.state === 'confirmed') return { event, changed: false }; // webhooks retry

    const res = await this.api.events.patch({
      calendarId: this.calendarId,
      eventId,
      requestBody: {
        summary: (event.summary || '').replace(/^HOLD · /, 'Booked · '),
        status: 'confirmed',
        transparency: 'opaque',
        description: `${event.description || ''}\n\nPayment: ${paymentRef} (${(paidCents / 100).toFixed(2)})`,
        extendedProperties: {
          private: props({ ...existing, state: 'confirmed', holdExpires: '', paymentRef, paidCents }),
        },
      },
    });
    return { event: res.data, changed: true };
  }

  async findByRef(ref) {
    const res = await this.api.events.list({
      calendarId: this.calendarId,
      privateExtendedProperty: [`app=${APP}`, `ref=${ref}`],
      showDeleted: false,
      singleEvents: true,
      maxResults: 5,
    });
    return (res.data.items || [])[0] || null;
  }

  /**
   * A cancelled booking stays on the calendar, clearly marked. Google treats
   * status:'cancelled' as a deletion, so the record is kept with its own flag
   * instead — the office can still see who cancelled and when.
   */
  async cancel(eventId, { refundCents = 0, by = 'guest' } = {}) {
    const { data: event } = await this.api.events.get({ calendarId: this.calendarId, eventId });
    const existing = (event.extendedProperties && event.extendedProperties.private) || {};
    if (existing.state === 'cancelled') return { event, changed: false };

    const note = refundCents > 0
      ? `Cancelled by ${by} — refunded ${(refundCents / 100).toFixed(2)}`
      : `Cancelled by ${by} — no refund due`;

    const res = await this.api.events.patch({
      calendarId: this.calendarId,
      eventId,
      requestBody: {
        summary: `CANCELLED · ${(event.summary || '').replace(/^(Booked|HOLD) · /, '')}`,
        transparency: 'transparent',
        description: `${event.description || ''}\n\n${note}`,
        extendedProperties: {
          private: props({ ...existing, state: 'cancelled', refundCents, cancelledBy: by }),
        },
      },
    });
    return { event: res.data, changed: true };
  }

  async release(eventId) {
    await this.api.events.delete({ calendarId: this.calendarId, eventId });
  }

  async findBySession(sessionId) {
    const res = await this.api.events.list({
      calendarId: this.calendarId,
      privateExtendedProperty: [`app=${APP}`, `sessionId=${sessionId}`],
      showDeleted: false,
      singleEvents: true,
      maxResults: 5,
    });
    return (res.data.items || [])[0] || null;
  }
}

/**
 * Same interface, held in memory. Runs the demo mode and the test suite, so the
 * booking rules can be exercised without touching a real calendar.
 */
class MemoryCalendarStore {
  constructor(seed = []) {
    this.events = new Map();
    this.nextId = 1;
    for (const e of seed) this.put(e);
  }

  put(event) {
    const id = event.id || `evt_${this.nextId++}`;
    this.events.set(id, { ...event, id });
    return this.events.get(id);
  }

  async listEvents() {
    return [...this.events.values()];
  }

  async listOccupancy(from, to, siteTypes, siteIndex) {
    const events = await this.listEvents();
    return events
      .filter((e) => e.start.date < addDays(to, 1) && e.end.date > from)
      .flatMap((e) => eventToRecords(e, siteTypes, siteIndex));
  }

  async createHold(record, quote, holdExpires) {
    return this.put({
      summary: bookingSummary(record, 'hold'),
      description: bookingDescription(record, quote),
      start: { date: quote.arrival },
      end: { date: quote.departure },
      status: 'tentative',
      extendedProperties: {
        private: props({
          app: APP,
          state: 'hold',
          siteTypeId: quote.siteTypeId,
          siteNumber: record.siteNumber,
          units: 1,
          guests: record.guests,
          name: record.name,
          email: record.email,
          phone: record.phone,
          ref: record.ref,
          holdExpires,
          totalCents: quote.total,
          depositCents: quote.deposit,
        }),
      },
    });
  }

  async attachSession(eventId, sessionId) {
    const event = this.events.get(eventId);
    if (!event) return;
    event.extendedProperties.private.sessionId = String(sessionId);
  }

  async confirm(eventId, { paymentRef, paidCents }) {
    const event = this.events.get(eventId);
    if (!event) {
      const err = new Error('Booking hold no longer exists');
      err.status = 404;
      err.code = 'hold_missing';
      throw err;
    }
    const p = event.extendedProperties.private;
    if (p.state === 'confirmed') return { event, changed: false };
    p.state = 'confirmed';
    p.holdExpires = '';
    p.paymentRef = String(paymentRef);
    p.paidCents = String(paidCents);
    event.description = `${event.description || ''}\n\nPayment: ${paymentRef} (${(paidCents / 100).toFixed(2)})`;
    event.status = 'confirmed';
    event.summary = (event.summary || '').replace(/^HOLD · /, 'Booked · ');
    return { event, changed: true };
  }

  async findByRef(ref) {
    for (const event of this.events.values()) {
      const p = (event.extendedProperties && event.extendedProperties.private) || {};
      if (p.ref === String(ref)) return event;
    }
    return null;
  }

  async cancel(eventId, { refundCents = 0, by = 'guest' } = {}) {
    const event = this.events.get(eventId);
    if (!event) {
      const err = new Error('That booking is no longer on the calendar');
      err.status = 404;
      err.code = 'booking_missing';
      throw err;
    }
    const p = event.extendedProperties.private;
    if (p.state === 'cancelled') return { event, changed: false };
    p.state = 'cancelled';
    p.refundCents = String(refundCents);
    p.cancelledBy = by;
    event.summary = `CANCELLED · ${(event.summary || '').replace(/^(Booked|HOLD) · /, '')}`;
    event.description = `${event.description || ''}\n\nCancelled by ${by}`;
    return { event, changed: true };
  }

  async release(eventId) {
    this.events.delete(eventId);
  }

  async findBySession(sessionId) {
    for (const event of this.events.values()) {
      const p = (event.extendedProperties && event.extendedProperties.private) || {};
      if (p.sessionId === String(sessionId)) return event;
    }
    return null;
  }
}

module.exports = {
  APP,
  GoogleCalendarStore,
  MemoryCalendarStore,
  eventToRecords,
  parseBlock,
  bookingSummary,
  bookingDescription,
};
