'use strict';

const path = require('path');
const express = require('express');

const { assertDate, addDays, today } = require('./dates');
const { ratesConfigured, isPriced, fromRate } = require('./pricing');
const bookings = require('./bookings');
const mail = require('./mailer');
const tokens = require('./tokens');
const sitemap = require('./sitemap');

/**
 * The booking API. Built as a factory so the tests can drive it with a memory
 * calendar and a stub payment provider, and `server.js` can wire in the real
 * Google Calendar and Stripe.
 */

const AVAILABILITY_MAX_DAYS = 120;

function rateLimiter({ windowMs = 60000, max = 20 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests — please try again in a minute.' });
    }
    return next();
  };
}

function publicRates(rates, { bookingOpen, hasSiteMap }) {
  return {
    bookingOpen,
    currency: rates.currency,
    taxRate: rates.taxRate,
    taxLabel: rates.taxLabel,
    checkIn: rates.checkIn,
    checkOut: rates.checkOut,
    minNights: rates.minNights,
    maxNights: rates.maxNights,
    maxGuests: rates.maxGuests,
    bookingWindowDays: rates.bookingWindowDays,
    season: rates.season,
    depositMode: (rates.deposit && rates.deposit.mode) || 'first_night',
    holdMinutes: bookings.HOLD_MINUTES,
    cancellation: rates.cancellation || {},
    hasSiteMap: Boolean(hasSiteMap),
    extras: rates.extras || {},
    seasons: rates.seasons || [],
    siteTypes: rates.siteTypes.map((t) => ({
      id: t.id,
      name: t.name,
      blurb: t.blurb,
      inventory: t.inventory,
      nightly: t.nightly,
      weekly: t.weekly,
      monthly: t.monthly,
      // What the chips say, and whether this type can be booked online at all.
      from: fromRate(rates, t),
      bookable: isPriced(rates, t),
    })),
  };
}

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on our end. Please call the campground.' : err.message,
    code: err.code || 'error',
  });
}

function createApp({ rates, store, payments, mailer, secret, siteMap, staticDir, publicUrl }) {
  const app = express();
  const deps = {
    rates,
    store,
    payments,
    secret: secret || 'insecure-development-secret',
    siteMap: siteMap || null,
    siteIndex: siteMap ? sitemap.index(siteMap) : null,
  };
  const bookingOpen = Boolean(payments) && ratesConfigured(rates);

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  /**
   * Stripe signs the raw body, so the webhook has to see the bytes before any
   * JSON parsing touches them. It is mounted ahead of express.json() for that
   * reason — moving it below would break signature verification.
   */
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
      event = payments.parseWebhook(req.body, req.get('stripe-signature'));
    } catch (err) {
      console.error('Rejected webhook:', err.message);
      return res.status(400).send(`Webhook signature check failed: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const confirmed = await bookings.confirmBySession(deps, session.id, {
          paymentRef: session.payment_intent || session.id,
          paidCents: session.amount_total,
        });
        if (!confirmed) {
          console.warn(`No hold found for session ${session.id} — booking may need manual entry`);
        } else if (confirmed.changed) {
          // Only on the transition. Stripe retries webhooks, and nobody wants
          // the same confirmation four times.
          await sendConfirmation(confirmed.event);
        }
      } else if (event.type === 'checkout.session.expired') {
        await bookings.releaseBySession(deps, event.data.object.id);
      }
      res.json({ received: true });
    } catch (err) {
      // A 500 tells Stripe to retry, which is what we want if Google was down.
      console.error('Webhook handling failed:', err);
      res.status(500).json({ error: 'handler_failed' });
    }
  });

  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, bookingOpen, calendar: store.constructor.name });
  });

  app.get('/api/config', (req, res) => {
    res.json(publicRates(rates, { bookingOpen, hasSiteMap: Boolean(deps.siteMap) }));
  });

  app.get('/api/sites', (req, res) => {
    if (!deps.siteMap) return res.status(404).json({ error: 'No site map is configured', code: 'no_site_map' });
    res.set('Cache-Control', 'public, max-age=300');
    res.json(sitemap.publicMap(deps.siteMap, rates));
  });

  app.get('/api/availability', async (req, res) => {
    try {
      const from = assertDate(String(req.query.from || today()), 'from');
      const to = assertDate(String(req.query.to || addDays(from, 60)), 'to');
      if (to < from) throw Object.assign(new Error('`to` must not precede `from`'), { status: 400, code: 'bad_range' });
      const capped = to > addDays(from, AVAILABILITY_MAX_DAYS) ? addDays(from, AVAILABILITY_MAX_DAYS) : to;

      const window = await bookings.availabilityWindow(deps, from, capped);
      res.set('Cache-Control', 'no-store');
      res.json({ from, to: capped, bookingOpen, grid: window.grid, sites: window.sites });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/quote', rateLimiter({ max: 60 }), async (req, res) => {
    try {
      const { quote } = await bookings.priceStay(deps, req.body || {});
      res.json({ quote });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/checkout', rateLimiter({ max: 12 }), async (req, res) => {
    try {
      if (!bookingOpen) {
        throw Object.assign(new Error('Online booking is not open yet — please call the campground.'), {
          status: 503,
          code: 'booking_closed',
        });
      }

      const held = await bookings.createHold(deps, req.body || {});

      let session;
      try {
        session = await payments.createCheckout({
          quote: held.quote,
          request: held.request,
          ref: held.ref,
          eventId: held.event.id,
          publicUrl,
        });
      } catch (err) {
        // Never leave a site held for a checkout that failed to start.
        await store.release(held.event.id);
        throw err;
      }

      await store.attachSession(held.event.id, session.id);
      res.json({ url: session.url, ref: held.ref, deposit: held.quote.deposit, total: held.quote.total });
    } catch (err) {
      sendError(res, err);
    }
  });

  async function sendConfirmation(event) {
    const booking = bookings.readBooking(event);
    const type = rates.siteTypes.find((t) => t.id === booking.siteTypeId);
    const quote = {
      siteTypeName: (type && type.name) || booking.siteTypeId,
      arrival: booking.arrival,
      departure: booking.departure,
      nights: Math.round((Date.parse(booking.departure) - Date.parse(booking.arrival)) / 86400000),
      total: booking.totalCents,
      deposit: booking.paidCents || booking.depositCents,
      balance: Math.max(0, booking.totalCents - (booking.paidCents || booking.depositCents)),
      tax: Math.round(booking.totalCents - booking.totalCents / (1 + rates.taxRate)),
      taxLabel: rates.taxLabel,
    };

    const guest = mail.guestConfirmation({
      booking,
      quote,
      checkIn: rates.checkIn,
      checkOut: rates.checkOut,
      cancelLink: tokens.cancelUrl(publicUrl, booking.ref, deps.secret),
      cancellation: rates.cancellation || {},
    });
    await mail.trySend(mailer, { to: booking.email, ...guest });

    const office = process.env.OFFICE_EMAIL || mail.CAMPGROUND.email;
    await mail.trySend(mailer, { to: office, ...mail.officeNotification({ booking, quote }) });
  }

  /** What the guest sees when they follow the cancellation link in their email. */
  app.get('/api/booking', async (req, res) => {
    try {
      const { booking, terms } = await bookings.lookupBooking(deps, req.query.ref, req.query.t);
      res.set('Cache-Control', 'no-store');
      res.json({
        booking: {
          ref: booking.ref,
          state: booking.state,
          siteTypeName: (rates.siteTypes.find((t) => t.id === booking.siteTypeId) || {}).name,
          arrival: booking.arrival,
          departure: booking.departure,
          guests: booking.guests,
          name: booking.name,
          totalCents: booking.totalCents,
          paidCents: booking.paidCents,
          refundCents: booking.refundCents,
        },
        terms,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/cancel', rateLimiter({ max: 10 }), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await bookings.cancelBooking(deps, { ref: body.ref, token: body.token });

      if (!result.alreadyCancelled) {
        await mail.trySend(mailer, {
          to: result.booking.email,
          ...mail.cancellationNotice({ booking: result.booking, refundCents: result.refundCents }),
        });
        await mail.trySend(mailer, {
          to: process.env.OFFICE_EMAIL || mail.CAMPGROUND.email,
          subject: `Cancelled — ${result.booking.ref}, ${result.booking.arrival}`,
          text: `${result.booking.name} cancelled ${result.booking.ref} (${result.booking.arrival} to ${result.booking.departure}).\nRefunded: $${(result.refundCents / 100).toFixed(2)}.\nThe site is back on sale.`,
        });
      }

      res.json({
        cancelled: true,
        alreadyCancelled: result.alreadyCancelled,
        refundCents: result.refundCents,
        ref: result.booking.ref,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // server.js reuses this for the demo payment route, so the sample walkthrough
  // exercises the same confirmation email as a real booking.
  app.locals.sendConfirmation = sendConfirmation;

  if (staticDir) {
    app.use(express.static(staticDir, { extensions: ['html'], maxAge: '1h' }));
    app.get('/', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  return app;
}

module.exports = { createApp, publicRates, rateLimiter };
