# All Points East — booking server

Takes reservations for the campground website: shows what's free, prices a stay,
charges a deposit through Stripe, and writes the booking into Google Calendar.

The website itself (`../allpointseast/index.html`) is a plain HTML file and works
without any of this. Add the server and the booking section on the page comes
alive; leave it off and the page tells guests to phone.

```
config/rates.json        the rate card and site inventory — the file you edit
lib/dates.js             calendar-date arithmetic (no time zones, ever)
lib/pricing.js           nightly/weekly/monthly rates, HST, deposit
lib/availability.js      how many sites of each type are free, night by night
lib/calendar.js          Google Calendar as the booking database (+ in-memory twin)
lib/payments.js          Stripe Checkout
lib/bookings.js          validation, holds, confirmations
lib/app.js               the HTTP API
server.js                wiring and start-up
```

## Try it in two minutes

```bash
npm install
npm run dev:demo      # sample rates, in-memory calendar, simulated payments
```

Open http://localhost:3000/#book and book a site. Nothing is charged, nothing
touches Google, and everything disappears when you stop the server — but it is
the same code path a real booking takes.

## Going live

### 1. Enter the rates

Open `config/rates.json` and fill in a `nightly` price for every site type, plus
`weekly` and `monthly` if longer stays get a better rate. Check the inventory
split too — it ships as 20 full-service / 12 power-and-water / 8 tent, adding up
to the 40 sites, but only the office knows the real breakdown.

**Until every bookable site type has a nightly rate, online booking stays shut**
and the website shows a "call to book" message. That is deliberate: the site
should never quote a price nobody entered.

`config/rates.sample.json` shows the shape with example numbers. Those numbers
are made up — do not ship them.

### 2. Connect Google Calendar

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project and enable the **Google Calendar API**.
2. Create a **service account**, then create a **JSON key** for it and download
   the file.
3. Copy the service account's email address (it ends in
   `.iam.gserviceaccount.com`).
4. In Google Calendar, make a calendar for bookings — "All Points East —
   Bookings" — then **Settings → Share with specific people → Add** that service
   account email with **Make changes to events**.
5. In the same settings page, copy the **Calendar ID**.

The service account is a robot with access to that one calendar and nothing
else. Share the calendar with the family's own Google accounts as well, so the
season fills up on everyone's phone.

### 3. Connect Stripe

1. Stripe dashboard → **Developers → API keys** → copy the **secret key**.
2. **Developers → Webhooks → Add endpoint**, pointing at
   `https://yourdomain.ca/api/stripe/webhook`, subscribed to
   **`checkout.session.completed`** and **`checkout.session.expired`**.
3. Copy that endpoint's **signing secret**.

Testing locally:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

### 4. Set the environment and start

Copy `.env.example` to `.env` and fill it in, then:

```bash
npm install --omit=dev
npm start
```

Any host that runs Node will do — Render, Railway, Fly, a small VPS. Set the
same variables in the host's dashboard rather than shipping a `.env` file, and
make sure `PUBLIC_URL` is the real https address, because Stripe sends guests
back to it after paying.

## How a booking works

1. The page asks `/api/availability` and paints the calendar.
2. The guest picks dates; `/api/quote` prices the stay. Nothing is reserved yet.
3. On **Book**, `/api/checkout` writes a *hold* to the calendar — a tentative
   all-day event — and opens a Stripe Checkout session.
4. The guest pays on Stripe's page.
5. Stripe's webhook flips the hold to a confirmed booking. If the guest wanders
   off, the session expires, the webhook releases the hold, and the site goes
   back on sale.

Holds last 35 minutes and stop counting against availability the moment they
lapse, so a forgotten checkout never keeps a site off the market.

## Running it day to day

**Closing sites off.** Create an all-day event on the bookings calendar titled
`BLOCK tent x2` — that takes two tent sites out of inventory for those dates.
`BLOCK full-service` blocks one. `BLOCK all — road work` closes everything.
Ordinary calendar events are ignored, so a dentist appointment on the same
calendar will not shut the campground.

**Bookings taken by phone.** Enter them the same way you always would; give the
event the title `BLOCK <site type>` so the website counts them, or take the
booking through the site yourself.

**Cancellations and refunds.** Refund in the Stripe dashboard, then delete the
event from the calendar. The site is free again the moment the event is gone.

**Reading a booking.** Every booking event carries the guest's name, email,
phone, party size, total, what they paid and what is owed on arrival, in the
event description.

## Environment variables

| Variable | Needed | What it is |
| --- | --- | --- |
| `PORT` | no | Defaults to 3000. |
| `PUBLIC_URL` | yes in production | The site's https address; Stripe returns guests here. |
| `GOOGLE_CALENDAR_ID` | yes | The bookings calendar's ID. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | yes | The service account key — raw JSON or base64. |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | alternative | Path to the key file instead of the above. |
| `STRIPE_SECRET_KEY` | yes | `sk_live_…` in production, `sk_test_…` while testing. |
| `STRIPE_WEBHOOK_SECRET` | yes | `whsec_…` from the webhook endpoint. |
| `RATES_FILE` | no | Point at a different rate card. |
| `DEMO` | no | `1` runs the sample-data walkthrough described above. |

Missing Google or Stripe settings do not crash the server — it logs what is
absent, keeps serving the website, and leaves booking closed.

## Tests

```bash
npm test
```

39 tests over the pricing rules, the availability arithmetic, and the booking
flow end to end — including double-booking, expired holds, replayed webhooks,
forged webhooks, and a Stripe outage mid-checkout. No network access needed.

## Known limits

- **Availability is counted per site type, not per numbered site.** The website
  sells "a full-service site"; which one a guest gets is settled at the office.
  Assigning specific sites would need a booking record per site.
- **The app sends no email.** Stripe emails the payment receipt if receipts are
  switched on in the Stripe dashboard; there is no separate confirmation email
  with directions and check-in times yet.
- **Cancellations are manual** — refund in Stripe, delete the calendar event.
- **The rate limiter is per process.** Running more than one instance behind a
  load balancer weakens it; put rate limiting at the proxy in that case.
- **A lapsed hold may linger on the calendar** as a tentative event if Stripe's
  expiry webhook never arrives. It stops blocking availability on its own; it is
  only visual clutter, and deleting it is safe.
