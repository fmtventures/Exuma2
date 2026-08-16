# Sidelio Website Builder — Architecture

## What this document is

The system design for the Sidelio Website Builder, and an honest map of what
is implemented in this repository versus what is specified for later work.

## 1. The shape of the product

Sidelio is a multi-tenant SaaS website platform. The differentiator is not the
editor — every competitor has one. It is the pipeline that runs *before* the
editor:

```
  a business
      │
      ▼
  Smart Import ──────►  Business Knowledge Graph  ──────►  Generated Site
  (crawl / files /       (facts + provenance +              (pages of blocks,
   API / interview)       confidence + approval)             brand tokens)
                                  │                                │
                                  ├──────────►  SEO / schema.org ───┤
                                  ├──────────►  AI assistant  ──────┤
                                  └──────────►  other Sidelio ──────┘
                                                 suite modules
```

The Knowledge Graph is the asset. Once Sidelio genuinely understands a
business — its services, people, locations, hours, prices, policies, and where
each of those facts came from — the website is one of several things that can
be generated from it. That is why it is a first-class, versioned, provenance-
tracked store rather than a scratch buffer inside the import job.

## 2. Principles

These are the constraints that shaped everything else.

**1. Uncertain facts never publish silently.**
Every value carries a `Fact` wrapper: source, locator, retrieval time,
confidence, approval state. `isPublishable()` is a single chokepoint the
renderer, the generator and the publisher all call. A model inference can
never auto-approve, no matter how confident it claims to be. The visible
consequence is that a freshly imported site is *quieter* than the original
until the owner reviews it — that is the correct trade, and the review queue
and migration warnings explain it.

**2. Nothing mutates a site directly.**
The editor, the AI assistant, Smart Import and bulk admin actions all produce
a `ChangeSet`: a list of reversible operations against addressable paths. Every
change can be summarized ("8 pages, 14 fields"), previewed against a sandbox
copy, applied atomically with precondition checks, and reverted from a stored
inverse. This is what makes large AI edits safe enough to offer at all.

**3. High-risk bulk edits are deterministic, not model-driven.**
"Change all phone numbers to 902-555-1234" is a find-and-replace across a known
set of paths. Handing that to a model would be slower, more expensive, and
occasionally wrong in ways the user would not notice on page 34. Models are used
where they add real value — open-ended authoring, restructuring, tone — and even
then the output is constrained: a model plan cannot reference an unknown page or
widen its own scope past the page being edited.

**4. Tenancy is enforced twice, independently.**
Once in application code (a pure, exhaustively testable permission function)
and once in the database (forced row-level security keyed on `org_id` and
`site_id`). Branded id types stop an `OrgId` being passed where a `SiteId`
belongs. A trigger rejects any child row whose `org_id` disagrees with its
parent site. Any one of these failing is survivable; all three failing is not
a bug we can write.

**5. Migration is authorized, attested and polite.**
No crawl starts without a recorded permission claim naming specific hosts, and
that claim is re-checked per URL. robots.txt is obeyed. The fetcher refuses
private and cloud-metadata addresses. Smart Import is a migration tool for
people moving their own site; it is not marketed, built or documented as a
website cloner.

**6. Providers are replaceable.**
No vendor SDK is imported by feature code. Text, image, edit, vision, embedding
and video are capability interfaces behind a registry with priority ordering
and failover. Swapping an image provider is a registration change.

**7. Generated output stays editable.**
Blocks are data, never markup. That is what lets the AI produce a page the user
can then take apart in the visual editor, and what lets one page render to
HTML, preview and static publish from a single source.

## 3. Module map

```
src/
  core/         ids, errors, results, tenancy, permissions,
                provenance, audit, change sets
  knowledge/    entity schemas (29 types), the knowledge graph
  import/       attestation, robots, fetcher, extractors, crawl
                pipeline, review model
  design/       brand kit, tokens, colour maths, contrast auditing
  blocks/       block schema (26 types), page and navigation model
  generate/     rebuild modes, industry architectures, site generation
  ai/           provider registry, Anthropic + mock adapters,
                Site Assistant
  media/        asset + rights model, smart crop, derivatives,
                duplicates, library audit, search
  render/       HTML renderer + sanitizer, SEO/AEO, sitemap, audit
  db/           schema.sql, rls.sql
  api/          HTTP layer: routes, permission checks, audit, preview
  admin/        admin UI + visual editor (no framework, no build step)
```

Boundaries are enforced by convention and import direction: `core` imports
nothing from the platform; `knowledge` imports `core`; everything else imports
downward. No cycles. Any of these directories can be extracted into its own
package or service without touching the others — `import/` and `media/` are the
two most likely to become separate workers first, since both are I/O-bound and
burst-heavy.

## 4. Request lifecycle

```
  request
    → authenticate           → Actor { userId, memberships, supportSession? }
    → resolve scope          → { orgId, siteId? }
    → decide(permission)     → pure function, no I/O
    → open transaction
        SET LOCAL sidelio.org_id / user_id / site_ids
        (RLS now independently enforces the same boundary)
    → build a ChangeSet      → summarize / preview
    → apply                  → atomic, precondition-checked, inverse stored
    → write audit event      → append-only, secrets scrubbed
    → commit
```

Reads of sensitive resources (form submissions, customer records, integration
secrets) are audited too; ordinary content reads are not, to keep volume sane.

## 5. Background work

Everything slow is a job, not a request. Jobs are idempotent and resumable,
keyed by `(site_id, job_type, dedupe_key)`.

| Job | Trigger | Notes |
|---|---|---|
| `import.crawl` | user starts Smart Import | budgeted by pages, depth and wall time; each page independent so one failure does not fail the job |
| `import.build_graph` | crawl completes | pure function over stored crawl output; safe to re-run |
| `media.derive` | asset upload / focal point change | generates the derivative set |
| `media.analyze` | asset upload | alt text, tags, subject box, perceptual hash, embedding |
| `media.dedupe_scan` | nightly per site | groups duplicates for review |
| `site.publish` | user publishes | snapshot → render → upload → cache invalidate → redirect map |
| `domain.verify` | domain added | DNS check with backoff, then certificate provisioning |
| `domain.renew_cert` | 30 days before expiry | |
| `seo.audit` | publish, and weekly | feeds the site health dashboard |
| `submissions.purge` | daily | enforces the retention policy |
| `ai.usage_rollup` | hourly | credit accounting per org |

Retries use exponential backoff and only for errors marked `retryable` on the
`SidelioError` — a validation failure is never retried.

## 6. Error handling

Every failure maps to an `ErrorCode` with a status, a safe user message, and a
retryable flag. Adding a failure mode means adding a code first, so no module
can produce an error the UI cannot translate. Business-flow failures return
`Result<T>`; exceptions are reserved for programmer error and infrastructure
faults.

## 7. Data protection

- Form submissions and customer records are personal data: read-audited,
  retention-bounded via `purge_after`, and excluded from site snapshots.
- Integration credentials never touch the database — `integrations.secret_ref`
  points at the secrets manager.
- Audit metadata is scrubbed of anything key-shaped before it is written.
- Published sites ship a strict CSP; user HTML is sanitized on write and again
  on render.
- JSON-LD output escapes angle brackets so structured data cannot break out of
  its own script tag.

## 8. What is built here

Implemented, tested, and typechecked (200 tests):

| Area | State |
|---|---|
| Tenancy, plans, module gating | complete |
| Permission engine (60 permissions, 9 roles) | complete |
| Provenance, confidence, publish gate | complete |
| Audit log with scrubbing | complete |
| Change sets: preview / apply / revert | complete |
| Knowledge graph, 29 entity types | complete |
| Smart Import: attestation, robots, crawl, extract, review | complete for HTML/URL sources |
| Rebuild modes and site generation | complete, 13 industry architectures |
| Brand kit, tokens, WCAG contrast auditing | complete |
| Block schema (26 types) and validation | complete |
| AI provider registry, Anthropic + mock adapters | complete |
| Site Assistant: deterministic + constrained model planning | complete |
| Media: rights, smart crop, derivatives, duplicates, search | complete (deterministic half) |
| Renderer, sanitizer, SEO/AEO, sitemap | complete |
| Database schema and RLS policies | complete, verified against a real Postgres |
| Admin HTTP API | complete for the modules above |
| Admin UI + visual editor | editor, import review, fact queue, brand kit, history, audit |

## 9. What is specified but not built

These are designed in `docs/module-specs.md` to the same twelve-point standard
(UX, data model, API, permissions, jobs, errors, audit, admin, AI,
extensibility, tests, risks) but have no code in this repository yet:

- Ecommerce (products, orders, customers, payments, checkout)
- Events, calendars and bookings
- Forms/leads runtime and CRM sync
- Banners, popups and announcements runtime
- Domains, hosting, SSL and publishing infrastructure
- Integrations, apps marketplace, automations, webhooks
- Email and SMS
- Analytics
- Billing and metering
- Non-HTML import adapters (WordPress XML, CSV, PDF, DOCX, cloud storage)
- Real image generation/editing provider adapters
- Multi-language publishing runtime

The foundations they depend on — tenancy, permissions, change sets, provenance,
audit, blocks, rendering, AI abstraction — are the parts that are hard to
retrofit, and those are done.

## 10. Known limitations

Stated plainly rather than discovered later:

- **Team and testimonial extraction is heuristic.** It reads headings and
  blockquotes. It will miss people on unusual markup and occasionally propose a
  non-person. Everything it finds lands in the review queue rather than on a
  page, which bounds the damage but does not eliminate the work.
- **Address detection requires a postal or zip code** on the line. Addresses
  written without one are missed. This is deliberate: looser matching produced
  confident nonsense.
- **The crawler does not execute JavaScript.** Sites that render content
  client-side will import as near-empty. A headless-browser fetcher implementing
  the same `Fetcher` interface is the intended fix.
- **`smartCrop` is geometry, not perception.** Without a vision-provided subject
  box it centre-crops. Subject detection must run first for good framing.
- **Perceptual hashes are consumed, not computed here.** `findDuplicates`
  expects `phash` to be populated by the media worker.
- **The renderer resolves dynamic blocks at publish time**, not during render;
  `products`, `calendar`, `booking` and `social_feed` emit placeholders that the
  publisher fills.
- **The admin store is in memory.** `npm run dev` seeds by running the import
  pipeline and holds state in maps; `src/db/schema.sql` is the persistent
  implementation and is not yet wired up. Restarting the dev server resets it.
- **The admin ships one dev actor.** There is no login: the API resolves a fixed
  `org_owner` and enforces permissions against it. Authentication is the missing
  piece, not authorization.
- **Approving a fact does not rewrite already-generated inline content.** It
  releases the fact to structured data, collection-backed sections and future
  generation; text already written into a block stays until edited.
