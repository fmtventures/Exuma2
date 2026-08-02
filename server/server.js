'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const crypto = require('crypto');

const { createApp } = require('./lib/app');
const { GoogleCalendarStore, MemoryCalendarStore } = require('./lib/calendar');
const { StripePayments } = require('./lib/payments');
const { ConsoleMailer, SmtpMailer, CAMPGROUND } = require('./lib/mailer');
const { ratesConfigured } = require('./lib/pricing');
const sitemap = require('./lib/sitemap');

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

  async refund(paymentRef, amountCents) {
    console.log(`▸ DEMO refund of ${(amountCents / 100).toFixed(2)} against ${paymentRef} (no money moved)`);
    return { id: `re_demo_${Math.random().toString(36).slice(2, 8)}` };
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

/**
 * The site map is optional. Without it the campground sells "a full-service
 * site" and sorts out which one at the office; with it, guests pick their own
 * square and the map is what says how many sites exist.
 */
function loadSiteMap(rates) {
  const file = process.env.SITES_FILE
    ? path.resolve(process.env.SITES_FILE)
    : path.join(__dirname, 'config', 'sites.json');
  if (!fs.existsSync(file)) {
    console.warn('▸ No site map found — the website will sell by site type only.');
    return null;
  }
  const map = sitemap.validate(JSON.parse(fs.readFileSync(file, 'utf8')), rates);
  console.log(`▸ Site map: ${map.sites.length} sites from ${path.basename(file)}`);
  return map;
}

const { rates: cardRates, file } = loadRates();
const siteMap = loadSiteMap(cardRates);
// The map is what can be walked and counted, so it settles how many sites of
// each type exist; the rate card settles what they cost.
const rates = siteMap ? sitemap.reconcile(siteMap, cardRates) : cardRates;

if (!ratesConfigured(rates)) {
  console.warn(`▸ No rates set in ${file} — online booking stays closed until every site type has a nightly rate.`);
}

/**
 * Mail is optional. Without SMTP the server keeps taking bookings and writes
 * what it would have sent to the log, so a mail outage never blocks a payment.
 */
function buildMailer() {
  const { SMTP_URL, SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
  if (!SMTP_URL && !SMTP_HOST) {
    console.warn('▸ Email is not configured — confirmations will be logged, not sent.');
    console.warn('  Set SMTP_URL (or SMTP_HOST/SMTP_USER/SMTP_PASS) and MAIL_FROM to send them.');
    return new ConsoleMailer();
  }

  const nodemailer = require('nodemailer');
  const transport = SMTP_URL
    ? nodemailer.createTransport(SMTP_URL)
    : nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || '') === '1',
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      });

  console.log(`▸ Email via ${SMTP_HOST || 'SMTP_URL'}`);
  return new SmtpMailer({
    transport,
    from: MAIL_FROM || `${CAMPGROUND.name} <${CAMPGROUND.email}>`,
    replyTo: process.env.OFFICE_EMAIL || CAMPGROUND.email,
  });
}

/**
 * Signs cancellation links. Without a fixed secret the links in already-sent
 * emails stop working after a restart, so production must set one.
 */
function bookingSecret() {
  if (process.env.BOOKING_SECRET) return process.env.BOOKING_SECRET;
  console.warn('▸ BOOKING_SECRET is not set — cancellation links will stop working when this process restarts.');
  return crypto.randomBytes(32).toString('hex');
}

const store = buildStore();
const payments = buildPayments();
const mailer = buildMailer();
const secret = bookingSecret();

const app = createApp({
  rates,
  store,
  payments,
  mailer,
  secret,
  siteMap,
  staticDir: STATIC_DIR,
  publicUrl: PUBLIC_URL,
});

if (payments instanceof DemoPayments) {
  const { confirmBySession } = require('./lib/bookings');
  app.get('/api/demo/pay', async (req, res) => {
    const session = payments.sessions.get(String(req.query.session || ''));
    if (!session) return res.status(404).send('Unknown demo session');
    const confirmed = await confirmBySession({ rates, store }, session.id, {
      paymentRef: `demo_${session.id}`,
      paidCents: session.amount_total,
    });
    if (confirmed && confirmed.changed) await app.locals.sendConfirmation(confirmed.event);
    res.redirect(`/?booking=confirmed&ref=${encodeURIComponent(session.ref)}`);
  });
}

app.listen(PORT, () => {
  console.log(`▸ All Points East booking server on ${PUBLIC_URL}`);
});
