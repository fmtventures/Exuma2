'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { createApp } = require('./lib/app');
const { GoogleCalendarStore, MemoryCalendarStore } = require('./lib/calendar');
const { StripePayments } = require('./lib/payments');
const { ratesConfigured } = require('./lib/pricing');

const DEMO = process.env.DEMO === '1';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STATIC_DIR = path.resolve(__dirname, '..', 'allpointseast');

function loadRates() {
  const file = process.env.RATES_FILE
    ? path.resolve(process.env.RATES_FILE)
    : path.join(__dirname, 'config', DEMO ? 'rates.sample.json' : 'rates.json');
  return { rates: JSON.parse(fs.readFileSync(file, 'utf8')), file };
}

function loadServiceAccount() {
  const { GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_FILE } = process.env;
  if (GOOGLE_SERVICE_ACCOUNT_FILE) {
    return JSON.parse(fs.readFileSync(path.resolve(GOOGLE_SERVICE_ACCOUNT_FILE), 'utf8'));
  }
  if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    const raw = GOOGLE_SERVICE_ACCOUNT_JSON.trim().startsWith('{')
      ? GOOGLE_SERVICE_ACCOUNT_JSON
      : Buffer.from(GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8');
    return JSON.parse(raw);
  }
  return null;
}

function buildStore() {
  if (DEMO) {
    console.log('▸ DEMO mode: bookings are held in memory and disappear on restart');
    return new MemoryCalendarStore();
  }

  const credentials = loadServiceAccount();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!credentials || !calendarId) {
    console.warn('▸ Google Calendar is not configured — falling back to an in-memory calendar.');
    console.warn('  Set GOOGLE_CALENDAR_ID and GOOGLE_SERVICE_ACCOUNT_JSON to store bookings for real.');
    return new MemoryCalendarStore();
  }

  const { google } = require('googleapis');
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  });
  console.log(`▸ Google Calendar: ${calendarId}`);
  return new GoogleCalendarStore({ calendarId, auth, google });
}

/**
 * Stands in for Stripe when running `npm run dev:demo`, so the whole loop —
 * hold, pay, confirmed booking on the calendar — can be walked through without
 * keys. It never touches money and is only ever built when DEMO=1.
 */
class DemoPayments {
  constructor() {
    this.sessions = new Map();
  }

  async createCheckout({ quote, ref, eventId, publicUrl }) {
    const id = `cs_demo_${Math.random().toString(36).slice(2, 10)}`;
    this.sessions.set(id, { id, ref, eventId, amount_total: quote.deposit });
    return { id, url: `${publicUrl}/api/demo/pay?session=${id}` };
  }

  parseWebhook() {
    throw new Error('Demo mode does not accept webhooks');
  }
}

function buildPayments() {
  const key = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (DEMO && (!key || !webhookSecret)) {
    console.log('▸ DEMO mode: payments are simulated — no card is ever charged');
    return new DemoPayments();
  }
  if (!key || !webhookSecret) {
    console.warn('▸ Stripe is not configured — the site will show "call to book".');
    console.warn('  Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to take payments.');
    return null;
  }
  const stripe = require('stripe')(key);
  console.log(`▸ Stripe: ${key.startsWith('sk_live') ? 'LIVE keys' : 'test keys'}`);
  return new StripePayments({ stripe, webhookSecret });
}

const { rates, file } = loadRates();
if (!ratesConfigured(rates)) {
  console.warn(`▸ No rates set in ${file} — online booking stays closed until every site type has a nightly rate.`);
}

const store = buildStore();
const payments = buildPayments();

const app = createApp({
  rates,
  store,
  payments,
  staticDir: STATIC_DIR,
  publicUrl: PUBLIC_URL,
});

if (payments instanceof DemoPayments) {
  const { confirmBySession } = require('./lib/bookings');
  app.get('/api/demo/pay', async (req, res) => {
    const session = payments.sessions.get(String(req.query.session || ''));
    if (!session) return res.status(404).send('Unknown demo session');
    await confirmBySession({ rates, store }, session.id, {
      paymentRef: `demo_${session.id}`,
      paidCents: session.amount_total,
    });
    res.redirect(`/?booking=confirmed&ref=${encodeURIComponent(session.ref)}`);
  });
}

app.listen(PORT, () => {
  console.log(`▸ All Points East booking server on ${PUBLIC_URL}`);
});
