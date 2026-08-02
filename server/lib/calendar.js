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

/** Owner-created blocks: "BLOCK full-service x3" or "BLOCK all — road work". */
function parseBlock(summary, siteTypes) {
  if (!summary) return null;
  const text = String(summary).trim();
  if (!/^block\b/i.test(text)) return null;

  const rest = text.slice(5).trim().toLowerCase();
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

function eventToRecords(event, siteTypes) {
  const props = (event.extendedProperties && event.extendedProperties.private) || {};
  const arrival = event.start && event.start.date;
  const departure = event.end && event.end.date;
  if (!arrival || !departure) return []; // timed events are somebody's meeting, not a stay

  if (props.app === APP && props.siteTypeId) {
    return [{
      eventId: event.id,
      siteTypeId: props.siteTypeId,
      arrival,
      departure,
      units: Number(props.units || 1),
      state: props.state || 'confirmed',
      holdExpires: props.holdExpires || null,
      sessionId: props.sessionId || null,
      ref: props.ref || null,
      name: props.name || null,
      email: props.email || null,
    }];
  }

  const blocks = parseBlock(event.summary, siteTypes);
  if (!blocks) return [];
  return blocks.map((b) => ({
    eventId: event.id,
    siteTypeId: b.siteTypeId,
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
  return `${label} · ${record.siteTypeName} · ${who}`;
}

function bookingDescription(record, quote) {
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  return [
    `${record.siteTypeName} — ${quote.nights} night${quote.nights === 1 ? '' : 's'}, ${record.guests} guest${record.guests === 1 ? '' : 's'}`,
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

  async listOccupancy(from, to, siteTypes) {
    const events = await this.listEvents(from, to);
    return events.flatMap((e) => eventToRecords(e, siteTypes));
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
    if (existing.state === 'confirmed') return event; // webhooks retry; confirming twice is a no-op

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
    return res.data;
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

  async listOccupancy(from, to, siteTypes) {
    const events = await this.listEvents();
    return events
      .filter((e) => e.start.date < addDays(to, 1) && e.end.date > from)
      .flatMap((e) => eventToRecords(e, siteTypes));
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
    if (p.state === 'confirmed') return event;
    p.state = 'confirmed';
    p.holdExpires = '';
    p.paymentRef = String(paymentRef);
    p.paidCents = String(paidCents);
    event.description = `${event.description || ''}\n\nPayment: ${paymentRef} (${(paidCents / 100).toFixed(2)})`;
    event.status = 'confirmed';
    event.summary = (event.summary || '').replace(/^HOLD · /, 'Booked · ');
    return event;
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
