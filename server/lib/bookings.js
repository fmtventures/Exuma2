'use strict';

const crypto = require('crypto');
const { assertDate, addDays, nights, today, inSeason, eachNight } = require('./dates');
const { quote, ratesConfigured } = require('./pricing');
const { computeAvailability, isStayAvailable, unavailableNights } = require('./availability');

// Stripe will not expire a Checkout Session sooner than 30 minutes, so the
// hold has to outlast that or a lapsed hold could still take a payment.
const HOLD_MINUTES = 35;

function fail(message, code, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function reference() {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY3479';
  const bytes = crypto.randomBytes(5);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `APE-${out}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Everything the guest typed is checked here, on the server, before a price is
 * calculated or a site is held. The browser does the same checks to be helpful,
 * but these are the ones that count.
 *
 * The stay and the guest are validated separately: the website prices a stay
 * while the calendar is still being clicked, long before anyone has typed their
 * name, and asking for contact details to see a price would be backwards.
 */
function validateStay(rates, input, now = Date.now()) {
  const arrival = assertDate(String(input.arrival || ''), 'Arrival date');
  const departure = assertDate(String(input.departure || ''), 'Departure date');
  const n = nights(arrival, departure);

  if (n < 1) throw fail('Departure has to be at least one night after arrival', 'bad_range');
  if (n < rates.minNights) throw fail(`Minimum stay is ${rates.minNights} nights`, 'below_min_nights');
  if (n > rates.maxNights) {
    throw fail(`Stays longer than ${rates.maxNights} nights are booked over the phone — please call us`, 'above_max_nights');
  }

  const from = today(now);
  if (arrival < from) throw fail('That arrival date has already passed', 'past_date');
  if (arrival > addDays(from, rates.bookingWindowDays)) {
    throw fail('That date is further out than we take online bookings — please call us', 'outside_window');
  }

  const outOfSeason = eachNight(arrival, departure).filter((d) => !inSeason(d, rates.season));
  if (outOfSeason.length) {
    throw fail('Those dates fall outside the camping season', 'out_of_season');
  }

  const guests = Number(input.guests || 1);
  if (!Number.isInteger(guests) || guests < 1 || guests > rates.maxGuests) {
    throw fail(`Please enter between 1 and ${rates.maxGuests} guests`, 'bad_guests');
  }

  return { siteTypeId: String(input.siteTypeId || ''), arrival, departure, guests };
}

function validateGuest(input) {
  const name = String(input.name || '').trim();
  if (name.length < 2) throw fail('Please give us a name for the booking', 'bad_name');

  const email = String(input.email || '').trim();
  if (!EMAIL_RE.test(email)) throw fail('Please check the email address', 'bad_email');

  return {
    name: name.slice(0, 120),
    email: email.slice(0, 200),
    phone: String(input.phone || '').trim().slice(0, 40),
    notes: String(input.notes || '').trim().slice(0, 800),
  };
}

function validate(rates, input, now = Date.now()) {
  return { ...validateStay(rates, input, now), ...validateGuest(input) };
}

/** Price plus an availability check, without holding anything. Drives the live summary on the page. */
async function priceStay({ rates, store }, input, now = Date.now()) {
  const request = validateStay(rates, input, now);
  const priced = quote(rates, request);

  const occupancy = await store.listOccupancy(request.arrival, request.departure, rates.siteTypes);
  const grid = computeAvailability(rates, occupancy, request.arrival, request.departure, now);

  if (!isStayAvailable(grid, request.siteTypeId, request.arrival, request.departure)) {
    const blocked = unavailableNights(grid, request.siteTypeId, request.arrival, request.departure);
    throw fail(
      `That site type is full on ${blocked.length} night${blocked.length === 1 ? '' : 's'} of your stay`,
      'unavailable',
      409
    );
  }

  return { request, quote: priced };
}

/**
 * Hold the site, then send the guest to Stripe. The hold is what stops two
 * people paying for the last full-service site at the same time; it lapses on
 * its own if the guest wanders off mid-checkout.
 */
async function createHold(deps, input, now = Date.now()) {
  const { rates, store } = deps;
  if (!ratesConfigured(rates)) {
    throw fail('Online booking is not open yet — please call the campground', 'rates_unconfigured', 503);
  }

  const { request: stay, quote: priced } = await priceStay(deps, input, now);
  const request = { ...stay, ...validateGuest(input) };
  const ref = reference();
  const holdExpires = new Date(now + HOLD_MINUTES * 60000).toISOString();
  const event = await store.createHold({ ...request, ref, siteTypeName: priced.siteTypeName }, priced, holdExpires);

  /**
   * Google Calendar has no transactions, so two guests clicking "book" in the
   * same second can both pass the check above before either hold exists. Read
   * back after writing: if the night is now oversubscribed, this hold loses and
   * is withdrawn. In the worst case both racers are asked to pick again, which
   * is a far better outcome than selling the same site twice.
   */
  const oversold = await findOversoldNight(deps, request, now);
  if (oversold) {
    await store.release(event.id);
    throw fail(
      'Someone reserved that site a moment before you did — please pick your dates again',
      'unavailable',
      409
    );
  }

  return { event, quote: priced, request, ref, holdExpires };
}

async function findOversoldNight({ rates, store }, request, now) {
  const occupancy = await store.listOccupancy(request.arrival, request.departure, rates.siteTypes);
  const type = rates.siteTypes.find((t) => t.id === request.siteTypeId);
  const inventory = (type && type.inventory) || 0;
  const nowMs = typeof now === 'number' ? now : Date.parse(now);

  const used = {};
  for (const record of occupancy) {
    if (record.siteTypeId !== request.siteTypeId) continue;
    if (record.state === 'hold' && record.holdExpires && Date.parse(record.holdExpires) <= nowMs) continue;
    for (const night of eachNight(record.arrival, record.departure)) {
      used[night] = (used[night] || 0) + (record.units || 1);
    }
  }

  return eachNight(request.arrival, request.departure).find((night) => used[night] > inventory) || null;
}

async function confirmBySession(deps, sessionId, { paymentRef, paidCents }) {
  const event = await deps.store.findBySession(sessionId);
  if (!event) return null;
  return deps.store.confirm(event.id, { paymentRef, paidCents });
}

async function releaseBySession(deps, sessionId) {
  const event = await deps.store.findBySession(sessionId);
  if (!event) return false;
  const state = event.extendedProperties.private.state;
  if (state === 'confirmed') return false; // paid after all — leave it alone
  await deps.store.release(event.id);
  return true;
}

/** The availability grid the calendar widget paints. */
async function availabilityWindow({ rates, store }, from, to, now = Date.now()) {
  const occupancy = await store.listOccupancy(from, to, rates.siteTypes);
  return computeAvailability(rates, occupancy, from, to, now);
}

module.exports = {
  HOLD_MINUTES,
  validate,
  validateStay,
  validateGuest,
  priceStay,
  createHold,
  confirmBySession,
  releaseBySession,
  availabilityWindow,
  reference,
};
