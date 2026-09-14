# Property Valuation & Exit Package

`valuation.html` — a self-contained cap-rate valuation and exit-modelling tool.
Open the file in any browser. No install, no server, no build step.

## What it does

| Tab | Purpose |
|---|---|
| 1 · Property | Subject details and the prior appraisal used as the benchmark |
| 2 · Rent Roll | Unit-by-unit in-place vs. market rent, loss to lease, occupancy |
| 3 · Income & Expenses | Operating statement, in-place (T-12) beside stabilized |
| 4 · Valuation | Value by cap rate, variance to appraisal, NOI × cap sensitivity grid |
| 5 · Debt & Returns | DSCR, debt yield, LTV, net proceeds on a sale today, buyer's cash-on-cash |
| 6 · Exit Strategy | Multi-year projection, exit value, net proceeds, hold-vs-sell IRR |
| 7 · Export Package | A formatted broker/investor document, ready to print or send |

## Method

Two scenarios run in parallel through every calculation:

- **In-place** — contract rents today. This is what a buyer will underwrite and what
  a lender will size debt against.
- **Stabilized** — every unit at market rent. This is the negotiating range and it
  quantifies the loss to lease.

```
Gross Scheduled Rent + Other Income & Recoveries = Potential Gross Income
Potential Gross Income − Vacancy & Credit Loss   = Effective Gross Income
Effective Gross Income − Operating Expenses      = Net Operating Income
Net Operating Income ÷ Cap Rate                  = Value
```

Vacancy is applied to potential gross income including recoveries — a vacant unit
loses its CAM recovery along with its base rent. Management fees and structural
reserves are always deducted whether or not they are currently paid, because a
buyer and a lender will both underwrite them.

Mortgage payments default to **Canadian semi-annual compounding**; monthly (US)
compounding is selectable. The hold IRR is measured against the equity that would
be released by selling today, which makes it a direct hold-versus-sell hurdle rate.

## Seeded data

The tool opens preloaded with the **Hollis Avenue portfolio** (26, 30, 41 & 45 Hollis
Avenue, Stratford PE), taken from the McQuaid & Associates – ARA appraisal, file
#2026027, effective 9 February 2026:

- 22 tenancies, 35,612 ft² leasable, 2.76 acres, M-2 Business Park Zone
- Appraised value **$9,225,000** · stabilized NOI **$622,863** · cap rate **6.50%**
- Market rent benchmark of $20.27/ft² from the appraisal's micro-market survey

The engine reproduces the appraisal's NOI to within $5 and its direct-capitalization
value to within $63, so the model is calibrated against a designated appraiser's work
before any forward assumption is applied.

**Two inputs still need real numbers:** the current mortgage balance (Tab 5) and the
adjusted cost base (Tab 5, needed for the after-tax proceeds estimate). Everything
downstream — DSCR, LTV, net proceeds, IRR — stays blank or wrong until those are entered.

## Exports

- **Print / Save as PDF** — preferred. Honours CSS page breaks, keeps paragraphs and
  the signature block intact, no split tables.
- **Download PDF** — jsPDF fallback; renders block by block so tables and the signature
  are never split, and section headings stay with the table beneath them.
- **CSV** — rent roll, operating statement, cap-rate ladder, metrics and projection.
- **JSON** — full state, for re-import or for feeding the portal dashboard.

Document output uses Aptos (cover 20–24pt, headings 13–15pt, body 10.5–11pt,
tables 9–10pt, notes 8.5–9pt). The application UI uses Segoe UI.

## Saved properties

Each property can be saved by name to the browser's local storage and recalled from
the dropdown in the header, so the portfolio can be modelled one asset at a time.
Local storage is per-device — use **Export JSON** for anything that must survive a
machine change.

## Embedding in the portal dashboard

The file is deliberately namespaced so it can be folded into `index.html`:

- All state lives on a single `S` object; all styling is scoped to the classes defined
  in the `<style>` block plus Tailwind utilities already loaded by the portal.
- To embed, copy the `<section id="pane-*">` blocks and the `<script>` blocks into the
  portal, add the tab buttons, and rename the portal's existing `switchTab` **or** this
  file's — that is the only name collision with `index.html`.
- Alternatively, drop it in as `<iframe src="valuation.html">`, which needs no changes
  at all.

## Limitations

This is an owner's estimate, not an appraisal. Tax figures are indicative only —
capital gain, CCA recapture and the effect of the corporate structure need an
accountant before any sale price is committed to.
