# BrokerFlow Review Brief — a script for an outside AI reviewer

**Purpose:** get a second, independent opinion on BrokerFlow (`bf.ftventures.ca`) — a graded
report card, a list of what is duplicated or badly named, a simpler navigation structure, and
mockups we can react to as a team.

**How to use it:** three steps. Gather the material (Step 1), paste the main script (Step 2),
then use the follow-ups (Step 3) to get mockups and an implementation spec.

---

## Step 1 — Gather the material (20 minutes)

The reviewer can only be as good as what it can see. Capture these, name the files clearly
(`01-login.png`, `02-home-broker.png`, …) and upload them all at once.

**Must have**
- The login screen.
- The first screen after login — one for a **broker/admin** account, one for an **agent** account if they differ.
- The main navigation, fully expanded. Also the mobile version of the nav.
- One screenshot of **every top-level page**. Do not skip the ones you rarely open — those are usually the duplicates.
- A record/detail page with real data in it (a deal, a listing, an agent profile).
- The longest form in the product.
- One **empty state** — a page with nothing in it yet. This is what a new agent actually sees.
- The two screens you use most, and the one screen you like least.

**Very helpful**
- A typed list of every navigation label, exactly as written, top level and sub-items. Screenshots get
  misread; typed labels do not.
- A 2–3 minute screen recording of you doing one real task, narrating what you are doing and why.
- Any error message you have run into.
- The same landing screen photographed on your phone.

**Before you upload:** use a test account, or blur client names, civic addresses, and dollar figures.
Brokerage records are confidential and regulated — the reviewer does not need real client data to
judge the layout.

**If you can export the code instead:** zip the front-end (routes, page components, nav config) and
upload that too. It lets the reviewer see every route, including the ones that no longer appear in
the menu.

---

## Step 2 — The main script

Paste everything between the lines into ChatGPT Pro, together with the screenshots.
Edit the two blocks marked **EDIT** first — they take two minutes and they change the whole answer.

---

You are a senior product designer and information architect. Your background is back-office
software for regulated industries — real estate brokerages, insurance, accounting practices. You
have run dozens of UX audits on internal tools that grew feature by feature. You are direct and
specific, and you do not open with compliments.

I am the broker/owner. I built this platform myself with AI assistance. I am not precious about it —
I want it judged the way you would judge a competitor's product.

### The product

**BrokerFlow** (`bf.ftventures.ca`) — the internal back-office platform for a real estate brokerage
in Prince Edward Island, Canada.

**EDIT — replace this block with your own description:**
- What it does today, in five lines: ______
- The list of top-level navigation items, exactly as they are labelled: ______
- Roles that log in (broker/owner, admin staff, agent, other): ______
- Roughly how many people use it, and how often: ______
- What is deliberately unfinished, so you don't waste time on it: ______

**Who uses it**
- The broker/owner — daily, knows where everything is, built it.
- Admin staff — daily, high volume, accuracy matters more than speed.
- Real estate agents — a few times a week, between showings, often on a phone in a car. Frequently
  45+, not technical, and many have never used a back-office tool of any kind. **This is the user
  who matters most in your review.** If an agent has to ask how to do something, that is a defect.

**The problem I want solved**

It works. It has also grown one feature at a time, and I am the only person who knows the map.
I believe there is duplication — the same job reachable from several places, and features that do
nearly the same thing under different names. I think there are too many top-level items, and no
obvious "start here" for someone new. I want it simpler, tidier, and obvious to a stranger.

### What I want from you — five deliverables

**A. Report card.** Score each dimension in the rubric below out of 10, with one line of evidence per
score. Give a weighted total out of 100 and a letter grade. Then: the three changes that would move
the grade up one full letter, in order.

**B. Cold-start test.** Put yourself in the chair of an agent on day one who has never seen this tool.
Walk these jobs step by step, from the login screen:

**EDIT — replace with your real five jobs. Defaults for a brokerage back office:**
1. Set up my profile for the first time.
2. Add a new listing.
3. Register an accepted offer and upload the signed agreement.
4. Check a deal's status and see which documents are still missing.
5. Find out what commission I am owed on a closed deal.

For each: the click path, the number of screens and clicks, and the exact point where a new user
would hesitate, guess, or pick the wrong thing. Name the screen and the element. If the material
doesn't show enough to complete a path, say where it goes dark instead of guessing.

**C. Duplication and consolidation register.** A table:

| # | What overlaps | Where it appears | Why it confuses a new user | Where it should live instead | What happens to the other entry point | Risk of merging |

Include near-duplicates: two labels for the same concept, two forms capturing the same data, a
report that repeats a dashboard, an orphan page nothing links to.

**D. Navigation redesign.** Current structure as you observe it, then a proposed structure.
- No more than six primary items. Justify every one that survives.
- Group by the job the user came to do, not by how the system is built.
- Naming rules, stated and applied consistently: pick nouns or verbs and stay with it, plain language
  over industry shorthand, no two labels that could plausibly mean the same thing.
- For every current page, say exactly where it goes: kept, merged into X, demoted to a sub-page,
  or removed. Nothing may silently vanish.
- Flag anything that needs a database or back-end change rather than a front-end move.

**E. Mockups.** Five screens:
1. The new home screen after login — **this is the hero, full fidelity.**
2. The main list view (deals, listings — whichever carries the most traffic).
3. A record/detail view.
4. The highest-friction workflow from part B, redesigned.
5. The most-used screen at 390px wide, on a phone.

Requirements:
- One self-contained HTML file. Inline CSS. No frameworks, no external dependencies except Google Fonts.
- Real labels and realistic local data — Charlottetown and Stratford addresses, CAD, 15% HST. Never lorem ipsum.
- **Keep the existing colours, logo and general look.** This is a reorganization, not a rebrand.
  Sample the palette from my screenshots.
- Show an empty state, a loading state, and an error state on at least one screen. New users live in empty states.
- Numbered callouts on each screen. Under each screen: one line of "why this changed" and one line of
  "what this replaces."
- Finish with a before → after click count for the five jobs in part B.

If you can only do one screen properly, do the home screen at full fidelity and give the other four
as annotated wireframes. One convincing screen beats five thin ones.

### Grading rubric

| Dimension | Weight | What a 10 looks like |
|---|---|---|
| Navigation & information architecture | 20 | A stranger finds any feature in under 15 seconds without asking. |
| Duplication & consistency | 15 | One job, one place. Same concept, same word, every time. |
| First-run experience | 15 | A new agent gets to their first useful action unaided. |
| Task efficiency | 15 | Core jobs take the minimum honest number of clicks. |
| Labels & plain language | 10 | Every label means what a non-technical agent thinks it means. |
| Forms & data entry | 10 | Short, grouped, forgiving, obvious what is required. |
| Visual hierarchy & readability | 5 | The important thing on each screen is the thing you see first. |
| Mobile & responsiveness | 5 | Fully usable one-handed on a phone. |
| Errors, empty states & accessibility | 5 | Errors say what to do next; empty states teach; contrast and targets are adequate. |

Score bands: 9–10 exceptional · 7–8 solid with minor friction · 5–6 works but costs the user time ·
3–4 confusing, needs work · 1–2 broken or missing.

### Rules of engagement

- Open with the verdict. No preamble, no praise sandwich. If something is genuinely well done, one
  line, then move on.
- Every finding cites a **specific screen and element**, and says what a first-time agent would do wrong.
  "Improve the navigation" is not a finding.
- Label each finding **OBSERVED** (visible in what I gave you) or **ASSUMED** (your inference). Never
  present an assumption as fact. If the material doesn't cover something, write "not covered" rather
  than filling the gap with a guess.
- Severity: Blocker / High / Medium / Polish. Effort: S (under an hour) / M (half a day) / L (multi-day).
- Maximum 15 findings in the main list, ranked by severity × frequency of use. Everything else goes in
  a one-line appendix.
- **Simplify, do not add.** Prefer removing, merging, and renaming over new features. Do not propose a
  rebrand, a rewrite, or a new framework. Every recommendation must be implementable in the existing stack.
- Do not invent features I have not asked for or a business model I have not described.
- Ask me questions only if a wrong assumption would change your recommendations — maximum five, up front.
  Otherwise state your assumptions plainly and carry on.

### Output format

1. **Verdict** — five lines maximum: the grade, and the single biggest problem.
2. **Report card** — the rubric table, scored, with evidence.
3. **Cold-start walkthrough** — the five jobs.
4. **Findings** — ranked, maximum 15, each with severity, effort, screen, and the fix.
5. **Duplication register** — the table.
6. **Navigation: before → after** — including where every current page lands.
7. **Roadmap** — This week / This month / Later, each item with effort and expected payoff.
8. **Open questions and assumptions.**
9. **Three decisions I need to make** — the calls that are mine, not yours, so my team can discuss them.

Mockups come in your next message, not this one.

Talk to me like a colleague who wants this to be good, not like a consultant protecting a
relationship. I would rather read something uncomfortable than something polite.

---

## Step 3 — Follow-ups

### 3a. Mockups (send after you have read the audit)

> Now build deliverable E, the mockups. Follow the spec exactly: one self-contained HTML file, my
> existing palette, real PEI data, numbered callouts, and the before → after click counts. Home screen
> at full fidelity first — if you run out of room, the other four can be annotated wireframes.
> Also state which of your findings each screen fixes.

### 3b. Implementation spec (once we have agreed on a direction as a team)

> Convert the changes we agreed on into a build specification I can hand to a developer. I need:
> the exact final navigation tree; every label change as a find → replace pair; every page's
> disposition (keep / merge / demote / remove) with its destination; routing and redirect changes so
> no existing link breaks; anything requiring a database or back-end change, called out separately;
> and the whole thing ordered as a checklist where each step leaves the product working. No code —
> just the spec.

### 3c. If the answer comes back vague

> - "You gave me principles. Give me the specific screen, the specific element, and the specific change."
> - "Which three would you do first if you had one day? Why those three?"
> - "You are being polite. What is the worst thing about this product?"
> - "Show me the click path for that job, step by step, before and after."
> - "You skipped the empty states. What does a brand-new agent with no deals actually see?"

---

## Reading the answer

Worth acting on: findings that name a screen and an element, click paths you can verify yourself,
and merges where the reviewer says what happens to the abandoned entry point.

Worth ignoring: anything that starts with a rebrand, anything that adds a feature, generic advice
that would apply to any product, and any nav proposal that doesn't say where the current pages go.

Bring the report card and the mockups to the team as a starting point for argument, not a verdict.
The reviewer has seen screenshots. You have seen agents use it.
