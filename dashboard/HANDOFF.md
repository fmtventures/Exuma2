# Handoff — read this first

You are picking up work that happened in a Claude Code **web** session on
2026-08-17. That conversation is gone; this file plus `registry.json` is what
carried over. Read both before doing anything.

## What this is

`dashboard/` is the **Build Board** — Francis's development platform. He was
tracking eight-plus tools across roughly ten separate chats and losing the thread.
This is the one place that holds what exists, what state it's in, how the modules
connect, what to do next, and what was already decided.

`registry.json` is the single source of truth. Everything else renders it.

## Get it running

```sh
node dashboard/serve.mjs        # → http://127.0.0.1:4321
```

Node 18+, no dependencies, no install. Binds `127.0.0.1` only. In this mode the
board **saves edits straight into `registry.json`** — the badge in the top bar
reads *local · saves to file*. That is the mode Francis wants; the hosted copy is
read-only.

## First thing to do locally

Find his projects and match them to the board:

```sh
node dashboard/scan-folders.mjs ~/Projects          # report only
node dashboard/scan-folders.mjs ~/Projects --write  # record the paths
```

Ask him which folders to scan; he may have several. The **"ON DISK, NOT ON THE
BOARD"** section of that report is the valuable part — it is likely to answer
three open questions at once (see *Blocked* below).

Then re-sync the module shelf, pointing at his local Studio checkout:

```sh
node dashboard/sync-modules.mjs <path-to-Financial-tool>
node dashboard/build.mjs
```

## The state of play

Eleven tools tracked. The important thing to understand, because the first
version of this board got it wrong:

- **`fmtventures/Financial-tool` is not a financial tool.** It is **FT Ventures
  Studio**, internally "The Ship" — a static module platform with **14 wired
  modules** and a Builder that composes them into branded per-client portals.
  `MODULES.md` in that repo is excellent and worth reading in full before
  touching it.
- **"BF" means BrokerFlow**, one of those 14 modules. Not a separate product.
- **The "website builder" is also already a module** on the same shelf, wired.
- **So the module-attachment mechanism Francis originally asked for already
  exists.** Do not design a new one. Pricing is by module count — Starter $49 /
  Pro $149 / Platform $399 — which `studio/pitch.html` marks as placeholder.
- **Sidelio** (`sidelio-site`) is a full club-management platform, ~30 pages, PWA
  with a Capacitor store runbook, on Supabase. It has **its own module system** in
  `docs/club-platform-modules.md`, which overlaps the Studio shelf.
- **The Lighthouse** (`lighthouse-dashboard`) is a finance command centre. Three
  Studio modules were built from its ideas, so the same capability lives in two
  places.

## Blocked on Francis — ask him these

On the board's **Now** view. Each is holding something else up.

1. **Is anyone paying for a Studio portal yet?** Highest-value unknown on the
   board. Decides whether the next week is building or selling.
2. **What is Claire 80?** Described only as "(presentations)". No repo in the org
   matches it. `scan-folders.mjs` may find it.
3. **Which repo is behind `peifotoshop.com`?** Best candidate to be the Studio's
   first real customer — the Website and Gallery modules were both built from its
   ideas.
4. **Is Pelot Photos a product, a client site, or the same code as PEI Fotoshop?**
5. **Sidelio app store release** — needs his Apple/Google accounts and a build
   machine. `MOBILE-APP.md` is the runbook; everything codeable is done.

## Decisions already made — don't re-argue these

Full list with reasoning in the **Decisions** view. Five settled, two awaiting his
call:

- *Proposed:* **Supabase for the Studio's Phase 2**, rather than rebuilding on
  Bubble, WeWeb or Retool. Already in Sidelio's stack, keeps the static-site
  architecture, avoids a per-seat cost under a $49/mo product.
- *Proposed:* **move `dashboard/` off `fmtventures/Exuma2`**, which is a public
  repo — `registry.json` holds the pricing model and strategic notes.

## Rules this board follows

Breaking these makes it worse than useless, because Francis makes real decisions
from it.

- **Never invent an effort number.** `hours` and `tokens` are `null` wherever they
  were not measured, and stay that way. A fabricated figure becomes the basis for a
  real prioritisation call. Same for `percentComplete: null`, which renders as
  "Progress not estimated" rather than an empty bar so unknown never reads as 0%.
- **Never hand-edit a Studio module.** Anything with `source:
  "studio/registry.js"` comes from The Ship and is overwritten on the next sync.
  Change it in the Studio repo instead.
- **Keep the confidence badges accurate.** `verified` means you read the repo or
  the running code. `assumed` means inference. `unknown` means placeholder. Do not
  promote a row to `verified` without actually checking.
- **Log the session.** Add a `sessions` entry for what you did. That is the only
  way effort tracking ever becomes real.

## What local unlocks that the web session could not

The web container's network policy blocked `peifotoshop.com`,
`dashboard.ftventures.ca`, `pelotphotos.com` and `sidelio.ca`, so four tools were
never inspected. Locally they are reachable — worth doing, and it is queue item
`q13` (live status checks).

Live GitHub activity also isn't wired: `api.github.com` returns 403 for this org
because the Claude GitHub App isn't connected to `fmtventures`. Locally, his own
git credentials work.

## Where things live

| | |
|---|---|
| Branch | `claude/dev-dashboard-platform-35z5kt` |
| PR | fmtventures/Exuma2#7 (draft) |
| Hosted read-only copy | the artifact link Francis has |
| Full docs | `dashboard/README.md` |
