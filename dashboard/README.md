# Build Board — FT Ventures development dashboard

One page that answers: what have we built, what state is it in, how do the modules
connect, and what should we work on next.

It is deliberately boring technology — a JSON file and a single HTML page, no
database, no build pipeline, no accounts. That means it works from a file on disk,
from GitHub Pages, or from a shared link, and it can be upgraded later without
throwing anything away.

## The files

| File | What it is |
|---|---|
| `registry.json` | **The single source of truth.** Every tool, module, connection, client and log entry. This is the file to edit. |
| `index.html` | Page shell. |
| `styles.css` | All styling. Light and dark themes are both defined as token sets. |
| `app.js` | Rendering, filtering, editing, charts. |
| `serve.mjs` | Local server. Run this and edits save straight to `registry.json`. |
| `build.mjs` | Inlines the four files above into single-file builds. |
| `dist/index.html` | Standalone build — open it directly in a browser. |
| `dist/artifact.html` | Same page as content-only, for publishing as a Claude Artifact. |

## Two ways to run it

The page tells you which mode you are in — a badge next to the title in the top bar.

### Local mode — edits save to the file (recommended)

```sh
node dashboard/serve.mjs        # → http://127.0.0.1:4321
```

Requires Node 18+ and nothing else. No `npm install`. The badge reads
**local · saves to file**, and the button in each tool panel says
**Save to registry.json** — pressing it writes the file, keeps the previous
version as `registry.json.bak`, and rebuilds `dist/` automatically.

The server binds to `127.0.0.1` only, so it is not reachable from the network. It
refuses to save anything that is not a structurally valid registry, which means a
bad request cannot blank the file.

Add `--port 8080` if 4321 is taken.

### Read-only mode — a page you can open anywhere

Open `dist/index.html` directly, host it, or use the published link. The badge
reads **read-only**. Everything is still editable in the browser, but since there
is no server to write to, the button says **Copy changes** and you use the patch
loop below.

After editing `registry.json` by hand, rebuild:

```sh
node dashboard/build.mjs
```

The build validates the registry and reports any module or tool id that is
referenced but not defined, so a typo shows up as a warning instead of a blank
row on the page.

## The editing loop without a server

1. Open any tool and edit its fields. Changed fields are outlined in brass.
2. A bar appears at the top of the page: **N unsaved changes**.
3. Press **Copy changes**. That puts a small JSON patch on your clipboard.
4. Paste it into a chat with Claude. It gets applied to `registry.json`,
   committed, and the page is rebuilt.

Edits live in that browser's local storage until they are sent, so closing the tab
does not lose them — but nothing is shared with anyone else until step 4.

**Copy working brief** on each tool does the opposite direction: it produces a
paste-ready summary of one tool — status, repo, modules, blockers, next actions —
so a fresh chat can pick that tool up with full context instead of starting cold.
That is the fix for work being spread across ten conversations.

## Reading the data honestly

Every tool carries a confidence badge, and it means what it says:

- **verified** — confirmed by reading the repo or the running code.
- **assumed** — a repo exists or the tool was named, but the details are inference.
- **unknown** — a placeholder. Needs filling in.

**Hours and tokens are blank everywhere.** That is not an oversight. There is no
record of effort from the earlier chats and no API that can backfill it, so the
fields are null rather than estimated — a made-up number would quietly become the
basis for a real decision. They fill in from here on, either by typing what you
remember or by adding a log entry per session.

## The registry shape

```jsonc
{
  "tools": [{
    "id": "website-builder",          // stable slug, referenced elsewhere
    "name": "Website Builder",
    "tagline": "One line on what it is",
    "platformId": "ftventures",       // -> platforms[].id
    "status": "building",             // live | beta | building | paused | idea | unknown
    "health": "good",                 // good | warning | serious | critical | unknown
    "percentComplete": null,          // null renders as "not estimated", never 0%
    "repo": "owner/name",
    "liveUrl": "https://…",
    "confidence": "assumed",
    "lastTouched": "2026-08-17",
    "effort":   { "hours": null, "tokens": null, "sessions": null },
    "priority": { "rank": 1, "impact": 5, "effort": 4, "rationale": "why" },
    "provides": ["site-builder"],     // -> modules[].id
    "consumes": [],
    "nextActions": [{ "text": "…", "done": false }],
    "blockers":    [{ "text": "…", "since": "2026-08-17" }],
    "notes": "free text"
  }],

  "modules": [{ "id": "site-builder", "name": "Site Builder",
                "ownerToolId": "website-builder", "kind": "feature" }],

  // the point of the whole thing: which module attaches to which product,
  // and on what commercial terms
  "connections": [{
    "moduleId": "site-builder",
    "toToolId": "bf",
    "type": "paid-addon",             // paid-addon | bundled-free | api | planned | idea
    "status": "planned",              // live | planned | idea
    "notes": "why"
  }],

  "clients": [{ "id": "…", "name": "…", "type": "paying", "toolIds": ["bf"] }],
  "log":     [{ "date": "2026-08-17", "toolId": "…", "summary": "…",
                "hours": null, "tokens": null }]
}
```

## What it does not do yet

- **No shared persistence.** Local mode writes to the file on your machine. Two
  people editing on two machines would need a real backend — Supabase would be
  about an afternoon.
- **No live status checks.** It does not ping the sites to see whether they are up.
  Worth adding once the repos are linked, and it works from local mode where there
  is no network policy in the way.
- **No automatic token or time capture.** Claude account usage is not readable
  from here.
- **It lives in the Exuma2 repo**, which is really the Sandy Palms portal's home.
  It should move to its own repo once it has earned it.
