# Cap Rate Desk — Valuation & Exit Package

`valuation.html` — a self-contained valuation, projection and exit-modelling tool for
the commercial portfolio. Open the file in any browser. No install, no server, no build
step. It is the same engine as the hosted version, wrapped in a plain HTML document so
it also runs straight off disk.

## What it does

| Tab | Purpose |
|---|---|
| 01 · Overview | Concluded value, variance to the appraisal benchmark, headline metrics |
| 02 · Rent Roll | Lease-by-lease terms, dates, base rent, CAM, escalations, status |
| 03 · Income & Expenses | Operating statement across all three scenarios |
| 04 · Valuation | Value by cap rate, variance to appraisal, NOI × cap sensitivity grid |
| 05 · Lease Risk | WALT, rollover profile, tenant concentration, expiry schedule |
| 06 · Projection | Rolling-year and calendar-year NOI, contracted vs. assumed revenue |
| 07 · Sale Price | Value at any date or quarter out to the horizon, at any cap rate |
| 08 · Debt & Exit | DSCR, debt yield, LTV, net proceeds, hold-versus-sell IRR |
| 09 · Tax on Sale | Recapture, capital gain, corporate tax, CDA, fiscal timing |
| 10 · Investor Package | A formatted broker/investor document, ready to print or send |

## Method

### Three scenarios, in parallel

- **In-place** — active leases only. What a buyer underwrites and a lender sizes debt against.
- **Committed** — in-place plus leases signed but not yet commenced.
- **Stabilized** — all leasable area at market rent. The negotiating range, and the
  measure of loss to lease.

```
Gross Scheduled Rent + Other Income & Recoveries = Potential Gross Income
Potential Gross Income − Vacancy & Credit Loss   = Effective Gross Income
Effective Gross Income − Operating Expenses      = Net Operating Income
Net Operating Income ÷ Cap Rate                  = Value
```

Vacancy is applied to potential gross income **including recoveries** — a vacant unit
loses its CAM recovery along with its base rent. Management fees and structural reserves
are always deducted whether or not they are currently paid, because a buyer and a lender
will both underwrite them.

### One monthly series behind every view

Revenue is built month by month, per tenancy, from the actual term dates and contractual
escalations on the rent roll. Each month is classified as **contracted** (inside a signed
term) or **assumed** (a re-let or renewal the model has projected), so the forward numbers
can always be split into what is on paper and what is a forecast.

Everything downstream derives from that single series:

- **Rolling years** and **calendar years** are buckets of it.
- **Quarters** report the quarter's NOI, its annualized equivalent, and the forward-12 run rate.
- **A value at any date** is the forward 12-month NOI from that month, capitalized.
- Re-letting uses a selectable assumption — market rent, hold the expiring rent, or a
  blend — with a downtime allowance between terms.

Because a cap rate changes value but never income, the series is built once per render
and reused. Rolling Year 1 NOI and the forward-12 run rate at month zero are the same
number by construction.

### Debt and tax

Mortgage payments default to **Canadian semi-annual compounding**; monthly (US) compounding
is selectable. The hold IRR is measured against the equity that would be released by selling
today, which makes it a direct hold-versus-sell hurdle rate.

The tax tab allocates net proceeds across parcels by value share, splits each parcel into
land and building on the cost-base ratio, then separates **recapture of CCA** (fully taxable)
from the **capital gain** (half taxable, half to the capital dividend account), applies the
corporate rate and the refundable portion, and runs the cash waterfall through to an optional
extraction to the shareholder. A share-sale alternative is shown alongside.

Fiscal timing matters as much as the arithmetic: the tab identifies the fiscal year end that
contains the closing date and the corporate balance-due date that follows it, so a closing
either side of the year end can be seen to move the whole liability by twelve months.

## Seeded data

The tool opens preloaded with the **Hollis Avenue portfolio** (26, 30, 41 & 45 Hollis Avenue,
Stratford PE), held by Francistheriault Ventures Inc.

Benchmark — McQuaid & Associates – ARA, report #2026027:

- 22 tenancies, 35,612 ft² leasable, 2.76 acres, M-2 Business Park Zone
- Report value **$9,225,000** effective 9 February 2026; the tool measures variance against
  the **$9,175,000** reliance letter of 8 June 2026, which is the current benchmark
- Stabilized NOI **$622,863** · cap rate **6.50%**
- Market rent benchmark of $20.27/ft² from the appraisal's micro-market survey

The engine reproduces the appraisal's NOI to within $5 and its direct-capitalization value
to within $63, so the model is calibrated against a designated appraiser's work before any
forward assumption is applied.

Rent roll — the Equitable Bank current rent roll as at **20 July 2026**, every lease's start,
expiry, base rent, CAM, area and status entered as stated. On that roll the in-place position
is materially below the appraisal's stabilized benchmark, which is the point of the exercise,
not a defect in it.

## Still outstanding

These are entered by hand and the figures that depend on them stay blank or indicative
until they are:

- **Mortgage** — EQ Bank loan #598842: amount, rate and maturity. Blocks DSCR, LTV, net
  proceeds, IRR and the net-proceeds column on the sale-price table.
- **T2 Schedule 8, per parcel** — adjusted cost base of the land, capital cost of the
  building, and closing UCC (Class 1). Blocks the recapture and capital-gain split.
- **Tax rates** — the four rates on the Tax tab are PEI CCPC estimates and are not
  verified against current legislation.
- **Operating statement** — the expense lines are the appraiser's normalized figures, not
  an actual T-12. Property tax in particular is unreconciled: the appraisal carries $50,858
  against 2026 statements totalling $38,836.59.
- **Escalations** — three leases carry an annual adjustment with no percentage stated on
  the roll (Refined Auto Detailing, Confound, ProTech), and Alignment Dance Studio has a
  renewal review at 1 June 2027 with no rate set.

The Tax tab's readiness panel lists what is missing and what each gap blocks.

## Exports

- **Print / Save as PDF** — preferred. Honours CSS page breaks, keeps paragraphs and the
  signature block intact, no split tables.
- **Download PDF** — jsPDF fallback; renders block by block so tables and the signature are
  never split, and section headings stay with the table beneath them.
- **CSV** — rent roll, operating statement, cap-rate ladder, metrics and projection.
- **JSON** — full state, for re-import or for feeding the portal dashboard.

Document output uses Aptos (cover 20–24pt, headings 13–15pt, body 10.5–11pt, tables 9–10pt,
notes 8.5–9pt). The application UI uses Segoe UI. Charts and the jsPDF export degrade
gracefully when the CDN is unreachable; printing is unaffected.

## Saved properties

Each property can be saved by name to the browser's local storage and recalled from the
dropdown in the header, so the portfolio can be modelled one asset at a time. Local storage
is per-device — use **Export JSON** for anything that must survive a machine change.

## Embedding in the portal dashboard

The file is built to fold into `index.html`:

- All state lives on a single `S` object. Styling is scoped to the classes in the `<style>`
  block and to the CSS custom properties defined on `:root`, so it does not inherit or
  disturb the portal's palette.
- Tab switching is `showPane(id)`; the portal's is `switchTab`. There is no top-level name
  collision between the two files.
- **Simplest route:** `<iframe src="valuation.html">`. No changes at all.
- **Merged route:** copy the `<section id="pane-*">` blocks and the `<script>` blocks into
  the portal and add the tab buttons. Wrap this file's scripts in an IIFE when you do —
  both files reuse short identifiers (`t`, `c`, `el`, `grid`, `rate`, `noi`) inside their
  own functions, and merging them into one top-level scope is the one thing that would
  make those clash.

## Limitations

This is an owner's estimate, not an appraisal. The tax figures are indicative only — the
capital gain, CCA recapture, the refundable mechanism and the effect of the corporate
structure all need an accountant before any sale price is committed to.
