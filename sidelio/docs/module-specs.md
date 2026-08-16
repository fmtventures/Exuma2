# Module Specifications

Each module below is specified to the same twelve points: UX, data model, API,
permissions, jobs, errors, audit, admin controls, AI capabilities,
extensibility, tests, and risks. All but the visual editor (§11, now partially
built) have no code in this repository yet — they build on the foundations that do.

Conventions assumed throughout: every table carries `org_id` and `site_id` and
is covered by RLS; every mutation flows through a `ChangeSet` where it edits
site content, and through a domain service where it does not (an order is not
site content); every mutation writes one audit event; every permission listed
already exists in `src/core/permissions.ts`.

---

## 1. Ecommerce

**UX.** Catalog → product → cart → checkout → order. The admin is Shopify-shaped
because that shape is correct and merchants already know it. Products live in a
CMS collection so a product detail page is a normal page template, editable in
the visual editor, rather than a separate rendering path — this is the main
divergence from Shopify and the reason a Sidelio storefront is designable
without a theme language.

**Data model.**
```
products(id, org_id, site_id, title, handle, description, status,
         vendor, product_type, tags[], seo jsonb, published_at)
product_variants(id, product_id, sku, title, price_cents, compare_at_cents,
         currency, weight_grams, option_values jsonb, barcode, position)
inventory_levels(variant_id, location_id, available, committed, policy)
collections_commerce(id, title, handle, rules jsonb, sort_order)
customers(id, email, name, phone, accepts_marketing, addresses jsonb,
         tax_exempt, note, created_at)
carts(id, token, customer_id, line_items jsonb, discount_codes[],
      currency, expires_at)
orders(id, number, customer_id, email, line_items jsonb, subtotal_cents,
       tax_cents, shipping_cents, discount_cents, total_cents, currency,
       financial_status, fulfillment_status, addresses jsonb,
       payment_reference, placed_at, cancelled_at)
refunds(id, order_id, amount_cents, reason, processed_at, processed_by)
discounts(id, code, type, value, applies_to jsonb, starts_at, ends_at,
          usage_limit, used_count)
tax_rates(id, country, region, rate, compound, applies_to)
shipping_zones / shipping_rates
```

Money is integer cents plus an ISO currency code, never a float. Order line
items are denormalized JSON snapshots: an order must still render correctly
after the product is renamed or deleted.

**API.**
```
GET    /api/sites/:siteId/products            list, filter, paginate
POST   /api/sites/:siteId/products
PATCH  /api/sites/:siteId/products/:id
POST   /api/sites/:siteId/products/:id/variants
GET    /api/sites/:siteId/orders              filter by status, date, customer
GET    /api/sites/:siteId/orders/:id
POST   /api/sites/:siteId/orders/:id/refunds
POST   /api/sites/:siteId/orders/:id/fulfillments
POST   /api/storefront/:siteId/carts          public, rate-limited
POST   /api/storefront/:siteId/carts/:token/lines
POST   /api/storefront/:siteId/checkouts      returns a payment intent
POST   /api/webhooks/payments/:provider       provider callback, signature-verified
```

**Permissions.** `commerce:read`, `commerce:manage_catalog`,
`commerce:manage_orders`, `commerce:refund`. Refund is deliberately separate:
the person who fulfils orders is often not the person allowed to move money.

**Jobs.** `commerce.sync_inventory`, `commerce.abandoned_cart` (scheduled per
cart TTL), `commerce.order_receipt`, `commerce.payout_reconcile`,
`commerce.low_stock_alert`, `commerce.tax_rate_refresh`.

**Errors.** `PRODUCT_UNAVAILABLE`, `INSUFFICIENT_INVENTORY`,
`PAYMENT_DECLINED`, `PAYMENT_PROVIDER_ERROR`, `DISCOUNT_INVALID`,
`DISCOUNT_EXPIRED`, `TAX_CALCULATION_FAILED`, `SHIPPING_UNAVAILABLE`,
`CHECKOUT_EXPIRED`, `REFUND_EXCEEDS_CHARGE`. Payment provider errors are
retryable; declines are not.

**Audit.** Every price change, inventory adjustment, order status transition,
refund, discount creation and customer data export. Refunds record the actor,
amount and reason and can never be edited afterwards.

**Admin controls.** Catalog, orders, customers, discounts, tax, shipping,
payment providers, abandoned carts, low-stock thresholds, currency, order
number format, receipt templates, and a per-store toggle for whether checkout
runs natively or hands off to a connected provider.

**AI.** Product description generation from title, specs and images (never
inventing specifications); bulk description rewriting with preview; product
image normalization via the media studio; SEO titles per product; category
suggestions; a review-summary block that aggregates rather than fabricates.
All product copy referencing a factual claim (materials, dimensions,
certifications) is written as a `Fact` and must be approved before publish.

**Extensibility.** `PaymentProvider`, `ShippingRateProvider`, `TaxProvider`,
`InventorySource` and `FulfillmentProvider` interfaces mirroring the AI
provider registry: named, priority-ordered, failover-capable. Checkout emits
`checkout.started`, `checkout.completed`, `order.paid`, `order.fulfilled`,
`order.refunded` to webhooks and automations.

**Tests.** Money arithmetic with rounding and multi-currency; tax across
compound jurisdictions; inventory oversell under concurrent checkout; discount
stacking and limits; partial and over-refund rejection; webhook signature
verification and replay rejection; order snapshot integrity after product
deletion; cart expiry.

**Risks.** Payment handling is the highest-consequence surface in the product.
It should launch as a thin orchestration layer over an established provider's
hosted checkout, with native checkout only after PCI scope is deliberately
decided. Tax is a compliance liability, not a feature — use a tax provider.

---

## 2. Events and Calendars

**UX.** An events collection with list, month, week and agenda views; a public
event page with registration; ICS subscription; embeddable filtered calendar.

**Data model.**
```
events(id, title, description, starts_at, ends_at, all_day, timezone,
       recurrence_rule, recurrence_exceptions[], location_id, venue_name,
       capacity, waitlist_enabled, registration_opens_at,
       registration_closes_at, status, image_asset_id)
event_occurrences(id, event_id, starts_at, ends_at, overridden jsonb)
ticket_types(id, event_id, name, price_cents, quantity, per_order_limit,
             sales_start, sales_end)
registrations(id, event_id, occurrence_id, ticket_type_id, attendee jsonb,
              status, order_id, checked_in_at)
calendar_feeds(id, site_id, token, filters jsonb)
```

Recurrence is stored as RFC 5545 RRULE with an exception list, and expanded
into `event_occurrences` by a job rather than at read time — a calendar view
that expands recurrences on every request will not survive a busy site.

**Timezones** are the failure mode here. Store `starts_at` in UTC *and* the
IANA timezone the organizer entered. A recurring 9am class stays at 9am local
across a DST boundary; a one-off webinar does not shift. These are different
behaviours and both are needed.

**API.** REST for events, occurrences, ticket types and registrations, plus
`GET /calendar/:token.ics` (public, token-scoped) and
`GET /api/storefront/:siteId/events?from=&to=&category=`.

**Permissions.** `event:read`, `event:manage`. Attendee lists are personal data:
reading them is audited and requires `submission:read`.

**Jobs.** `events.expand_recurrence` (on save, and rolling 24-month horizon),
`events.reminder` (per registration), `events.waitlist_promote`,
`events.calendar_sync` (Google/Microsoft two-way), `events.post_event_followup`.

**Errors.** `EVENT_FULL`, `REGISTRATION_CLOSED`, `INVALID_RECURRENCE_RULE`,
`OCCURRENCE_NOT_FOUND`, `CALENDAR_SYNC_FAILED`, `TIMEZONE_UNKNOWN`.

**Audit.** Event publish/cancel, capacity changes, registration exports,
check-ins, calendar connection changes.

**AI.** Event description drafting from title, date and venue; automatic
social/OG image generation via the media studio; suggested schedule from a
pasted programme; reminder copy; `Event` structured data emitted automatically.

**Extensibility.** `CalendarProvider` interface (Google, Microsoft, ICS,
CalDAV). Events emit `event.published`, `registration.created`,
`registration.cancelled`, `event.starting_soon`.

**Tests.** DST transitions in both directions; recurrence expansion against
RFC 5545 fixtures; exception dates; capacity race under concurrent
registration; waitlist promotion ordering; ICS output validated by a parser;
two-way sync conflict resolution.

---

## 3. Bookings

**UX.** Pick service → pick provider (or any) → pick slot → confirm. The hard
part is availability, not the UI.

**Data model.**
```
bookable_services(id, name, duration_minutes, buffer_before, buffer_after,
                  price_cents, capacity, booking_window_days,
                  min_notice_minutes, cancellation_policy)
providers(id, employee_id, timezone, active)
availability_rules(id, provider_id, weekday, starts_at, ends_at, effective_from,
                   effective_to)
availability_exceptions(id, provider_id, date, available, starts_at, ends_at)
bookings(id, service_id, provider_id, customer jsonb, starts_at, ends_at,
         status, order_id, notes, reminder_sent_at, cancelled_at)
```

**Availability** is computed, never stored as free slots: rules minus
exceptions minus existing bookings minus buffers minus external calendar busy
blocks, intersected with the booking window and minimum notice. It is the piece
most worth building as a pure, heavily-tested function — the same discipline as
the permission engine.

**API.** `GET /api/storefront/:siteId/availability?serviceId=&providerId=&from=&to=`,
`POST /api/storefront/:siteId/bookings`, admin CRUD for services, providers,
rules and exceptions.

**Permissions.** `booking:read`, `booking:manage`.

**Jobs.** `bookings.reminder`, `bookings.calendar_push`,
`bookings.no_show_sweep`, `bookings.availability_cache_warm`.

**Errors.** `SLOT_UNAVAILABLE`, `OUTSIDE_BOOKING_WINDOW`,
`BELOW_MINIMUM_NOTICE`, `PROVIDER_UNAVAILABLE`, `DOUBLE_BOOKING`,
`CANCELLATION_TOO_LATE`.

**Audit.** Booking creation, reschedule, cancellation, no-show marking,
availability rule changes, provider calendar connections.

**AI.** Suggested availability from a described schedule ("we're open weekdays
9–5 except Wednesday afternoons"); confirmation and reminder copy in brand
voice; no-show pattern surfacing.

**Extensibility.** `BookingProvider` interface so a business already using an
external scheduler keeps it while Sidelio renders the front end.

**Tests.** Double-booking under concurrency (the critical one — the slot check
and the insert must be one transaction with a uniqueness constraint, not a
read-then-write); buffer arithmetic; timezone differences between provider and
customer; DST; exception precedence over rules; minimum-notice boundaries.

---

## 4. Forms, Leads and CRM

**UX.** Build a form from field types, choose where submissions go, see leads
in a pipeline. Every form is also an automation trigger.

**Data model.** `forms`, `form_submissions` (already in `schema.sql`), plus
`leads(id, submission_id, contact jsonb, source, status, owner_id, score,
notes, crm_external_id, synced_at)` and `lead_activities(id, lead_id, kind,
body, at, actor_id)`.

**API.** `POST /api/forms/:formId/submissions` (public, rate-limited, spam
scored), admin list/export/delete, `POST /api/leads/:id/sync`.

**Permissions.** `form:read`, `form:update`, `submission:read`,
`submission:export`, `submission:delete`.

**Jobs.** `forms.notify`, `forms.crm_sync` with retry and dead-letter,
`forms.spam_rescore`, `submissions.purge` (retention).

**Errors.** `FORM_NOT_FOUND`, `VALIDATION_FAILED`, `SPAM_REJECTED`,
`RATE_LIMITED`, `CRM_SYNC_FAILED`, `RECIPIENT_UNVERIFIED`.

**Audit.** Submission reads and exports (personal data), field changes,
retention policy changes, CRM connections. Deletion records what was deleted
without retaining the payload.

**AI.** Form field suggestions by industry; spam classification; lead
summarization; suggested reply drafts; routing rules from a description.

**Extensibility.** `CrmProvider` interface (HubSpot, Salesforce, Pipedrive, and
Sidelio's own suite CRM), plus webhooks on `submission.created`.

**Tests.** Server-side validation matching the client's; honeypot and rate
limiting; injection attempts in every field type; export escaping (CSV formula
injection is the classic miss); retention purge correctness.

**Risks.** This is where personal data concentrates. Retention defaults must be
finite, exports audited, and notification recipients verified so a
misconfigured form cannot mail leads to an attacker-controlled address.

---

## 5. Banners, Popups and Announcements

**UX.** Compose → target → schedule → preview → publish. Everything is a block
with a visibility envelope, so this module is mostly targeting and scheduling
on top of the existing block system.

**Data model.** `announcements(id, site_id, type, content jsonb, placement,
targeting jsonb, schedule jsonb, priority, active, impressions, interactions)`.

**Targeting** supports page, device, referrer, campaign parameter, first-visit
versus returning, and logged-in status. Geographic targeting is offered only
where lawful and only at country/region granularity, resolved server-side at
the edge, never from client-supplied location.

**Scheduling** reuses `visibility.startsAt/endsAt`, plus recurrence and
business-hours windows evaluated in the site's timezone.

**Permissions.** `content:create` / `content:publish`.

**AI.** "Create a banner announcing we are closed Monday" is a deterministic
assistant handler: parse the date, generate the announcement, schedule it,
preview it. Copy variants and A/B suggestions are model work.

**Tests.** Priority resolution when several announcements match; dismissal
persistence; schedule boundaries across DST; targeting rule evaluation; that a
dismissed popup does not reappear on navigation.

**Risks.** Popups are the fastest way to ruin a site's usability and Core Web
Vitals. Ship with a frequency cap, a layout-shift-free implementation, and a
warning when more than one popup can fire on the same page.

---

## 6. Domains, Hosting and Publishing

**UX.** Add domain → shown exact DNS records → automatic verification →
certificate issued → live. Every state visible with a plain-English
explanation, because DNS is where non-technical users get stuck and abandon.

**Data model.** `domains` and `redirects` (in `schema.sql`), plus
`deployments(id, site_id, version_id, status, started_at, finished_at,
artifact_key, error)` and `certificates(id, domain_id, issuer, serial,
issued_at, expires_at, status)`.

**Publish pipeline.**
```
snapshot site → validate (broken links, missing alt, unresolved facts,
                          blocking warnings)
              → render every page + sitemap + robots
              → upload artifact
              → atomically flip the alias
              → invalidate CDN
              → write redirect map
              → audit
```
The flip is atomic and the previous artifact is retained, so rollback is
pointing the alias back — not a rebuild.

**API.** `POST /api/sites/:id/domains`, `GET .../domains/:id/verification`,
`POST /api/sites/:id/publish`, `POST /api/sites/:id/rollback`,
`GET /api/sites/:id/deployments`.

**Permissions.** `domain:read`, `domain:manage`, `site:publish`.

**Jobs.** `domain.verify` (backoff, gives up with an actionable message rather
than retrying forever), `domain.provision_certificate`, `domain.renew_cert`
(30 days out, alerting on failure), `site.publish`, `site.purge_cache`.

**Errors.** `DOMAIN_ALREADY_CLAIMED`, `DNS_RECORD_MISSING`,
`DNS_RECORD_MISMATCH`, `CAA_BLOCKS_ISSUANCE`, `CERTIFICATE_FAILED`,
`PUBLISH_VALIDATION_FAILED`, `DEPLOYMENT_FAILED`. Each carries the specific
record expected versus found — "verification failed" alone generates support
tickets.

**Audit.** Domain add/remove, primary domain change, every publish and rollback
with the version, certificate issuance and renewal.

**AI.** Pre-publish checklist in plain language; redirect map generation from
the import review (already implemented as `buildRedirectMap`); explanation of a
DNS failure in terms of what to change at which registrar.

**Extensibility.** `DnsProvider`, `CertificateProvider`, `CdnProvider`,
`ObjectStore` interfaces so the hosting substrate is replaceable.

**Tests.** Verification against fixture DNS responses including CAA records;
certificate renewal boundaries; publish rollback; redirect precedence and loop
detection; that a site with blocking warnings cannot publish.

**Risks.** Subdomain takeover if a removed domain keeps a dangling alias —
removal must revoke the alias before releasing the record. Certificate renewal
failure is a total outage and needs alerting independent of the platform.

---

## 7. Integrations, Apps and Automations

**UX.** A marketplace of connectors and an automation builder:
*when X happens, if Y, do Z*.

**Data model.** `integrations`, `webhooks` (in `schema.sql`), plus
`automations(id, site_id, name, trigger jsonb, conditions jsonb, actions jsonb,
active, last_run_at)`, `automation_runs(id, automation_id, status, context
jsonb, error, started_at, finished_at)`, and `apps(id, slug, name, publisher,
scopes[], config_schema jsonb, status)`.

**Event bus.** Every module emits typed events (`form.submitted`,
`order.paid`, `page.published`, `booking.created`, `import.completed`).
Automations subscribe. Webhooks are automations with an HTTP action, signed
with a per-webhook secret and an idempotency key, retried with backoff to a
dead-letter queue.

**Permissions.** `integration:read`, `integration:manage`,
`integration:manage_secrets` (separate — connecting an integration and reading
its credentials are different privileges), `automation:read`,
`automation:manage`.

**Errors.** `INTEGRATION_NOT_CONNECTED`, `INTEGRATION_SCOPE_MISSING`,
`OAUTH_EXPIRED`, `AUTOMATION_LOOP_DETECTED`, `WEBHOOK_DELIVERY_FAILED`,
`APP_NOT_INSTALLED`.

**Audit.** Connect/disconnect, scope grants, secret access, automation
create/edit/enable, every webhook delivery outcome.

**AI.** Automation authoring from a description; integration suggestions from
detected tracking tags during import (Smart Import already detects GA4, GTM,
Meta Pixel and cookie tooling, and the review warns that they need
reconnecting).

**Extensibility.** This module *is* the extensibility surface. Third-party apps
declare scopes, receive a scoped token, and register blocks, admin panels,
automation actions and webhook subscribers.

**Tests.** Loop detection (an automation whose action fires its own trigger);
webhook signature verification and replay rejection; idempotency under retry;
scope enforcement; token refresh; dead-letter behaviour.

**Risks.** Automation loops and runaway fan-out. Enforce per-site run quotas, a
depth limit on chained automations, and a circuit breaker per integration.

---

## 8. Analytics

**Approach.** First-party, cookieless by default, aggregated at the edge.
Privacy-preserving analytics is both the compliant choice and a genuine
differentiator against platforms that default to third-party tracking.

**Data model.** `page_views` (append-only, partitioned by day),
`events_analytics`, and rolled-up `daily_site_stats`. Raw rows have a short
retention; rollups persist.

**Metrics.** Sessions, pageviews, referrers, top pages, device class, Core Web
Vitals (LCP/CLS/INP from `web-vitals`), form conversion, ecommerce funnel,
booking conversion, and site health over time.

**Permissions.** `analytics:read`.

**AI.** Plain-language weekly summaries; anomaly surfacing ("contact form
submissions dropped 60% after Tuesday's publish" — which is actionable
precisely because publishes are versioned and timestamped).

**Tests.** Bot filtering; session boundary logic; timezone-correct daily
rollups; rollup idempotency on replay.

---

## 9. Billing and Metering

**Data model.** `subscriptions`, `invoices`, `usage_records`, `credit_grants`.
AI credits are metered in `ai_usage` (already in `schema.sql`) and rolled up
hourly.

**Enforcement.** `PLAN_LIMIT_REACHED` and `AI_QUOTA_EXCEEDED` are checked
*before* work starts, never mid-operation — a crawl must not stop halfway
through leaving a partial graph. `CreditGuard` (implemented in
`src/ai/provider.ts`) is the check point.

**Permissions.** `billing:read`, `billing:manage`. Deliberately absent from
`org_admin`.

**Audit.** Plan changes, payment method changes, limit overrides, credit grants.

**Risks.** Downgrade behaviour must be defined before launch: what happens to
site 4 of 3 when an agency downgrades. The answer should be "read-only and
unpublished", never "deleted".

---

## 10. Agency and Multi-Site Management

Mostly composition of what exists rather than new primitives, which is the
point of modelling an agency as an ordinary organization owning many sites.

**UX.** One table across all client sites: domain, status, plan, traffic,
forms, leads, orders, storage, AI usage, SSL expiry, health score, pending
updates, owner, billing. Bulk actions across selected sites.

**Needs building.** Cross-site aggregate queries; a site health score combining
the SEO audit, media library audit, broken links, certificate expiry and
unresolved facts; reusable templates and component libraries shared across an
org; white-label admin branding; client-facing restricted roles (`client_viewer`
already exists); consolidated billing.

**Permissions.** Brand locks (`brand:update` / `brand:unlock`) are implemented.
Block-level `locked` flags exist in the block schema and need editor enforcement.

**Tests.** That cross-site aggregation never crosses an org boundary — the
single most important test in this module, and one that must run against the
database with RLS active, not only against the permission function.

---

## 11. Visual Editor (front end) — partially built

**The four modes** from the specification map onto existing primitives:

| Mode | Backed by |
|---|---|
| Quick edit | direct field `set` operations |
| Block editor | insert / remove / move on `page.blocks` |
| Advanced design | `block.style` + brand tokens |
| AI | `SiteAssistant` plans |

Every mode produces a `ChangeSet`, so undo, version history, collaboration and
audit are uniform across all four rather than four separate implementations.

**Built** (`src/admin/`): section list with inline field editing, add/remove/
reorder, live preview at three breakpoints, the import review screen, the
record-grouped fact queue, the brand kit with contrast enforcement, version
history with undo, the audit log, and the assistant's preview/apply dialog.

**Still needed.** Drag-and-drop reordering; a full token-aware style panel;
per-block inspectors for the collection-backed types; media picker and the AI
Media Studio surfaces; presence and conflict indication for concurrent editors.

**Concurrency.** Change sets already carry preconditions and return
`PRECONDITION_FAILED` on stale writes. For multi-user editing that becomes a
"someone else changed this" prompt; true real-time co-editing would need CRDTs
at the block level and should be deferred until there is demand.

**Accessibility.** The editor itself must be keyboard-operable and screen-reader
usable. A website builder that cannot be used by a disabled operator while
generating accessible output for visitors is a contradiction worth avoiding
from the start.

**Tests.** Editor interactions produce valid `ChangeSet`s; preview matches
published output byte-for-byte given the same inputs; undo restores exactly;
keyboard navigation across every control.
