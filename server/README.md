# All Points East — booking server

Takes reservations for the campground website: shows what's free, prices a stay,
charges a deposit through Stripe, and writes the booking into Google Calendar.

The website itself (`../allpointseast/index.html`) is a plain HTML file and works
without any of this. Add the server and the booking section on the page comes
alive; leave it off and the page tells guests to phone.

```
config/rates.json        the rate card — prices, tax, deposit, cancellation
config/sites.json        the site map — every numbered site and where it sits
lib/dates.js             calendar-date arithmetic (no time zones, ever)
lib/pricing.js           nightly/weekly/monthly rates, HST, deposit
lib/availability.js      which sites are free, night by night
lib/sitemap.js           the site map: validation, inventory, service levels
lib/calendar.js          Google Calendar as the booking database (+ in-memory twin)
lib/payments.js          Stripe Checkout and refunds
lib/mailer.js            confirmation and cancellation email
lib/tokens.js            signed cancellation links
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

`config/rates.json` carries the campground's published rates, per season:

```json
"seasons": [
  { "id": "high", "name": "High season", "ranges": [["06-23", "09-07"]] },
  { "id": "low",  "name": "Low season",  "ranges": [["04-25", "06-22"], ["09-08", "11-02"]] }
],
"siteTypes": [
  { "id": "full-service-50", "nightly": { "high": 63, "low": 54 },
                             "weekly":  { "high": 385, "low": 325 } }
]
```

A rate can be one number all year or one per season. **A `null` price is never
guessed at**: the stay is refused with a message telling the guest to call, and
the office can fill the number in later without touching any code. Two are still
null and need confirming — the 30 amp low-season rate, and water-only, which is
currently phone-only on the website.

A stay that crosses the season line is charged each part at its own rate, and
each run of nights takes whichever of its monthly, weekly or nightly rate is
kinder. Booking stays open as long as *something* has a price; a type still
waiting on its rate simply cannot be picked online.

The deposit rule is the campground's own — `"mode": "greater_of"` takes one
night or 10% of the stay, whichever is larger. `first_night`, `percent` and
`full` are the other options.

`config/rates.sample.json` shows the simpler flat-rate shape, and is what the
test suite and `npm run dev:demo` use. Its numbers are made up — do not ship them.

### 2. Correct the site map

`config/sites.json` is the campground drawn as data — every numbered site, its
service level, and where it sits on the property. It is **traced from the
campground's own updated site map**, gaps and all: there is no site 1, 8, 40 or
41. The group tenting area is a closed zone rather than a site while storm
damage is repaired, and B40 — "Bunkin' at the Lake" — is drawn as a landmark
because it is a rental unit, not a campsite.

**What is still a guess is which sites carry which service.** The map does not
mark 50 amp against 30 amp against water-only, so the split below only
reconciles with the published inventory totals. Correct it before going live:

```json
{
  "number": "14",
  "typeId": "full-service",
  "amps": 50,
  "hookups": ["power", "water", "sewer"],
  "pullThrough": true,
  "x": 34, "y": 32,
  "features": ["Back-in", "Extra long"]
}
```

`x` and `y` are percentages across the map area, north at the top — moving a site
on the website is nudging two numbers. `landmarks`, `roads`, `water` and `trees`
work the same way and are what gets drawn around the sites.

This file decides how many sites exist. If the rate card disagrees, the map wins
and the server says so at start-up. Anything invalid — a repeated number, an
unknown type, a site with no position — stops the server rather than half-loading.

Guests filter the map by service (30 amp, 50 amp, full service, unserviced,
water-only, pull-through) and click the square they want. If they don't pick one,
the lowest-numbered free site of the type they chose is assigned automatically.
Sites whose type has no published rate — water-only today — are drawn dashed and
send the guest to the phone rather than into a checkout that would fail.

`zones` draws areas rather than sites: a `closed` zone is hatched in red and
sells nothing, while `grass` and `play` zones are just scenery. `notToScale`
prints the same caveat the campground's own map carries.

### 3. Connect Google Calendar

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

### 4. Connect Stripe

1. Stripe dashboard → **Developers → API keys** → copy the **secret key**.
2. **Developers → Webhooks → Add endpoint**, pointing at
   `https://yourdomain.ca/api/stripe/webhook`, subscribed to
   **`checkout.session.completed`** and **`checkout.session.expired`**.
3. Copy that endpoint's **signing secret**.

Testing locally:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

### 5. Turn on email (optional, but guests expect it)

Set `SMTP_URL` — for a Gmail or Google Workspace address that means an
[app password](https://support.google.com/accounts/answer/185833), not the
account password:

```
SMTP_URL=smtps://camp%40allpointseastcampground.ca:APP_PASSWORD@smtp.gmail.com:465
MAIL_FROM="All Points East Campground <camp@allpointseastcampground.ca>"
OFFICE_EMAIL=camp@allpointseastcampground.ca
```

Also set `BOOKING_SECRET` to a long random string. It signs the cancellation
link in every confirmation email; if it changes, links already sent stop
working, so set it once and leave it.

Without SMTP the server keeps taking bookings and prints the emails it would
have sent to the log — which is how you try the cancellation flow in demo mode.

### 6. Set the environment and start

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
5. Stripe's webhook flips the hold to a confirmed booking, emails the guest
   their details and cancellation link, and emails the office a heads-up. If
   the guest wanders off, the session expires, the webhook releases the hold,
   and the site goes back on sale.

Stripe retries webhooks, so the confirmation only fires on the transition from
hold to booked — nobody gets the same email four times. Email failures are
logged and swallowed: a mail server having a bad morning must never cost the
campground a paid booking.

## Cancellations

The confirmation email carries a link back to the site with the booking
reference and a signature. Knowing a reference is not enough — without the
signature the link is refused, so one guest can never reach another's booking.

Following it opens a panel with the booking, what a cancellation would refund,
and a two-step confirm button. On cancelling, the deposit is refunded through
Stripe if the policy allows, the calendar event is marked `CANCELLED` (kept for
the record, but no longer holding a site), and both guest and office are
emailed.

Two windows in `config/rates.json` set the policy:

```json
"cancellation": {
  "guestCancelUntilDays": 2,
  "refundDepositUntilDays": 7
}
```

Guests can cancel online until 2 days before arrival — closer than that they
are sent to the phone. Deposits come back in full when cancelling at least 7
days out; inside that, the cancellation still goes through but the deposit is
kept. The money moves before the calendar changes, so if Stripe refuses the
refund the booking stands and the guest is told to call, rather than losing
both their site and their deposit.

Holds last 35 minutes and stop counting against availability the moment they
lapse, so a forgotten checkout never keeps a site off the market.

## Running it day to day

**Closing sites off.** Create an all-day event on the bookings calendar:

| Title | What it does |
| --- | --- |
| `BLOCK 14` | Takes site 14 off the map for those dates |
| `BLOCK 14, 15, 16` | Takes all three off |
| `BLOCK tent x2` | Two tent sites, no particular square |
| `BLOCK all — road work` | Closes the campground |

Numbered blocks grey out on the map; a type block only reduces what is for sale,
because it names no square. Ordinary calendar events are ignored, so a dentist
appointment on the same calendar will not shut the campground.

**Bookings taken by phone.** Enter them the same way you always would; give the
event the title `BLOCK <site type>` so the website counts them, or take the
booking through the site yourself.

**Cancellations you handle yourself.** Guests can cancel from their
confirmation email. To do it for them, refund in the Stripe dashboard and
delete the event from the calendar — the site is free again the moment the
event is gone.

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
| `BOOKING_SECRET` | yes | Signs cancellation links; keep it stable. |
| `SMTP_URL` | no | Full SMTP URL. Without it, email is logged, not sent. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | no | The same thing in pieces. |
| `MAIL_FROM` | no | The From address on guest email. |
| `OFFICE_EMAIL` | no | Where new-booking notices go. Defaults to the campground address. |
| `RATES_FILE` | no | Point at a different rate card. |
| `SITES_FILE` | no | Point at a different site map. |
| `DEMO` | no | `1` runs the sample-data walkthrough described above. |

Missing Google or Stripe settings do not crash the server — it logs what is
absent, keeps serving the website, and leaves booking closed.

## Tests

```bash
npm test
```

75 tests over the pricing rules, seasonal rates, the availability arithmetic, the site map, and
the booking and cancellation flows end to end — including selling the same
square twice, changeover days, hand-written calendar blocks, expired holds,
replayed webhooks, forged webhooks, a Stripe outage mid-checkout, forged
cancellation links, double refunds, and a mail server that is down. No network
access needed.

## Known limits

- **The shipped site map is a placeholder** — real numbering, service levels and
  positions still need to be entered, as described above.
- **Without a site map the server falls back to selling by type**, leaving which
  site a guest gets to be settled at the office.
- **Email is plain text.** It is written to read well in any mail client, but
  there is no branded HTML version.
- **Guests cannot change a booking online**, only cancel it. Changing dates
  means cancelling and rebooking, or a phone call.
- **The rate limiter is per process.** Running more than one instance behind a
  load balancer weakens it; put rate limiting at the proxy in that case.
- **A lapsed hold may linger on the calendar** as a tentative event if Stripe's
  expiry webhook never arrives. It stops blocking availability on its own; it is
  only visual clutter, and deleting it is safe.
