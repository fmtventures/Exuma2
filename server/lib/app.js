'use strict';

const path = require('path');
const express = require('express');

const { assertDate, addDays, today } = require('./dates');
const { ratesConfigured } = require('./pricing');
const bookings = require('./bookings');

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

function publicRates(rates, { bookingOpen }) {
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
    extras: rates.extras || {},
    siteTypes: rates.siteTypes.map((t) => ({
      id: t.id,
      name: t.name,
      blurb: t.blurb,
      inventory: t.inventory,
      nightly: t.nightly,
      weekly: t.weekly,
      monthly: t.monthly,
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

function createApp({ rates, store, payments, staticDir, publicUrl }) {
  const app = express();
  const deps = { rates, store };
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
        if (!confirmed) console.warn(`No hold found for session ${session.id} — booking may need manual entry`);
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
    res.json(publicRates(rates, { bookingOpen }));
  });

  app.get('/api/availability', async (req, res) => {
    try {
      const from = assertDate(String(req.query.from || today()), 'from');
      const to = assertDate(String(req.query.to || addDays(from, 60)), 'to');
      if (to < from) throw Object.assign(new Error('`to` must not precede `from`'), { status: 400, code: 'bad_range' });
      const capped = to > addDays(from, AVAILABILITY_MAX_DAYS) ? addDays(from, AVAILABILITY_MAX_DAYS) : to;

      const grid = await bookings.availabilityWindow(deps, from, capped);
      res.set('Cache-Control', 'no-store');
      res.json({ from, to: capped, bookingOpen, grid });
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

  if (staticDir) {
    app.use(express.static(staticDir, { extensions: ['html'], maxAge: '1h' }));
    app.get('/', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  return app;
}

module.exports = { createApp, publicRates, rateLimiter };
