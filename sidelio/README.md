# Sidelio Website Builder

A multi-tenant AI website platform: give it a business — an existing website,
a pile of files, or just a conversation — and it builds a modern site it can
then keep managing.

This repository contains the platform foundation: the modules everything else
depends on, built, tested and typechecked. See
[`docs/architecture.md`](docs/architecture.md) for the full design and
[`docs/module-specs.md`](docs/module-specs.md) for the modules that are
specified but not yet implemented.

## Quick start

```bash
npm install
npm test          # 200 tests
npm run typecheck
npm run dev       # admin + visual editor at http://localhost:4310
npm run demo      # full pipeline against a fixture site
```

`npm run dev` starts the admin, seeded by actually running Smart Import against
the fixture site — so it opens on a website that came through the pipeline, not
on sample data. It has an editor with live preview, the import review screen,
the fact queue, the brand kit, version history and the audit log.

`npm run demo` runs the same pipeline headlessly, printing each stage and
writing the generated homepage to `dist/demo/index.html`.

## The idea

Every website builder has an editor. The part that is hard, and the part this
is built around, is everything that happens before the editor opens:

```
  Smart Import  ──►  Business Knowledge Graph  ──►  Generated Site
```

The Knowledge Graph is the asset. Once Sidelio genuinely understands a business
— services, people, locations, hours, prices, and **where each of those facts
came from** — a website is one of several things that can be generated from it.

## What makes it different

**Nothing uncertain publishes silently.** Every extracted value is a `Fact`
carrying its source, retrieval time, confidence and approval state. A model
inference can never auto-approve, however confident it claims to be. The visible
consequence is real: a freshly imported site is quieter than the original until
its owner reviews it. That is the correct trade — a missing phone number beats a
wrong one — and the review queue says exactly what is being held back and why.

**Nothing mutates a site directly.** The editor, the assistant, import and bulk
actions all produce a `ChangeSet`: reversible operations against addressable
paths, which can be summarized ("8 pages, 14 fields"), previewed against a
sandbox, applied atomically with precondition checks, and reverted from a
stored inverse.

**High-risk bulk edits are deterministic, not model-driven.** "Change all phone
numbers to 902-555-1234" is a find-and-replace across known paths — exact and
enumerable. Handing that to a model would be slower, costlier and occasionally
wrong somewhere the user would not check. Models handle open-ended work, and
even then a model plan cannot reference an unknown page or widen its own scope.

**Migration is authorized and polite.** No crawl runs without a recorded
permission claim naming specific hosts, re-checked per URL. robots.txt is
obeyed. The fetcher refuses private and cloud-metadata addresses. This is a
migration tool for people moving their own sites, not a website cloner.

**Tenancy is enforced twice.** A pure permission function in application code,
and forced row-level security in Postgres keyed on `org_id`/`site_id`. Branded
id types stop an `OrgId` being passed as a `SiteId`; a trigger rejects any child
row whose org disagrees with its parent site.

## Layout

```
src/
  core/       ids, errors, tenancy, permissions, provenance, audit, change sets
  knowledge/  entity schemas (29 types) and the knowledge graph
  import/     attestation, robots, fetcher, extractors, crawl, review
  design/     brand kit, tokens, colour maths, WCAG contrast auditing
  blocks/     block schema (26 types), page and navigation model
  generate/   rebuild modes and 13 industry content architectures
  ai/         provider registry, Anthropic + mock adapters, Site Assistant
  media/      rights, smart crop, derivatives, duplicates, library audit, search
  render/     HTML renderer + sanitizer, SEO/AEO, sitemap
  db/         schema.sql, rls.sql
  api/        HTTP API over the domain modules
  admin/      admin + visual editor (no framework, no build step)
  demo/       runnable end-to-end walkthrough
tests/        200 tests, including full-journey and HTTP integration tests
docs/         architecture and module specifications
```

`core` imports nothing from the platform; everything else imports downward. Any
directory can be extracted into its own package or service without touching the
others.

## Configuration

The Anthropic adapter reads its key from configuration, not the environment
directly:

```ts
new ProviderRegistry().register('anthropic', {
  text: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
});
```

Tests and the demo use `MockTextProvider`, which is deterministic and makes no
network calls.

## Status

Built and tested: tenancy, permissions, provenance, audit, change sets,
knowledge graph, Smart Import (HTML/URL sources), rebuild modes and generation,
brand kit, block schema, AI provider abstraction, Site Assistant, media studio
(deterministic half), renderer and SEO, database schema and RLS, the admin API,
and the admin UI with its visual editor.

Specified, not built: ecommerce, events/bookings, forms runtime, domains and
publishing infrastructure, integrations and automations, analytics, billing,
non-HTML import adapters, and image generation provider adapters.

Known limitations are listed explicitly in
[`docs/architecture.md`](docs/architecture.md#10-known-limitations) — the
crawler does not execute JavaScript, team extraction is heuristic, and address
detection requires a postal code, among others.
