/**
 * Syncs the dashboard's module list from The Ship's own registry.
 *
 *   node dashboard/sync-modules.mjs /workspace/financial-tool
 *
 * The Ship (fmtventures/Financial-tool) already keeps the authoritative module
 * shelf in `studio/registry.js` — id, name, tagline, wired state, which Claude
 * skills power it, and where the idea came from. Hand-copying that list into
 * registry.json would drift the moment a module is added, which is the exact
 * complaint the Studio was built to answer. So read it instead.
 *
 * Modules that came from the Studio are marked `source: "studio/registry.js"`.
 * Anything not from the Studio is left untouched, so hand-added modules for
 * tools outside The Ship survive a sync.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(here, 'registry.json');
const SOURCE_TAG = 'studio/registry.js';

const shipPath = process.argv[2];
if (!shipPath) {
  console.error('Usage: node dashboard/sync-modules.mjs <path-to-financial-tool-checkout>');
  process.exit(1);
}

const registryJs = resolve(shipPath, 'studio/registry.js');
if (!existsSync(registryJs)) {
  console.error(`Not found: ${registryJs}`);
  console.error('Point this at a checkout of fmtventures/Financial-tool.');
  process.exit(1);
}

/* Run the shelf in a sandbox. It assigns window.FTV_MODULES and window.FTV;
   the helpers on FTV reference browser globals but are never called here. */
let modules;
try {
  const sandbox = { window: {}, document: undefined, localStorage: undefined,
    btoa: () => '', atob: () => '' };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(registryJs, 'utf8'), sandbox, { timeout: 5000 });
  modules = sandbox.window.FTV_MODULES;
} catch (err) {
  console.error('Could not evaluate studio/registry.js:', err.message);
  process.exit(1);
}

if (!Array.isArray(modules) || !modules.length) {
  console.error('studio/registry.js did not produce a FTV_MODULES array.');
  process.exit(1);
}

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));

/* Everything on the shelf belongs to The Ship. */
const OWNER = 'ftv-studio';
if (!registry.tools.some((t) => t.id === OWNER)) {
  console.error(`registry.json has no tool with id "${OWNER}" to own these modules.`);
  process.exit(1);
}

const kindOf = (m) => (m.tools ? 'suite' : 'feature');

const synced = modules.map((m) => ({
  id: m.id,
  name: m.name,
  ownerToolId: OWNER,
  kind: kindOf(m),
  description: m.tagline || '',
  wired: m.wired === true,
  ideaFrom: m.from || null,
  skills: Array.isArray(m.skills) ? m.skills : [],
  href: m.href || null,
  subTools: (m.tools || []).map((t) => t.name),
  source: SOURCE_TAG,
}));

const kept = (registry.modules || []).filter((m) => m.source !== SOURCE_TAG);
const keptIds = new Set(kept.map((m) => m.id));
const collisions = synced.filter((m) => keptIds.has(m.id)).map((m) => m.id);
if (collisions.length) {
  console.error(`Hand-written modules collide with Studio ids: ${collisions.join(', ')}`);
  console.error('Rename or remove them — a duplicate id would render twice.');
  process.exit(1);
}

const before = (registry.modules || []).filter((m) => m.source === SOURCE_TAG).map((m) => m.id);
registry.modules = synced.concat(kept);

/* Drop connections whose module no longer exists, so the matrix cannot
   reference a module that was removed from the shelf. */
const liveIds = new Set(registry.modules.map((m) => m.id));
const staleConns = (registry.connections || []).filter((c) => !liveIds.has(c.moduleId));
registry.connections = (registry.connections || []).filter((c) => liveIds.has(c.moduleId));

/* Same for provides/consumes on every tool. */
registry.tools.forEach((t) => {
  t.provides = (t.provides || []).filter((id) => liveIds.has(id));
  t.consumes = (t.consumes || []).filter((id) => liveIds.has(id));
});

/* The Ship provides everything on its own shelf. */
const ship = registry.tools.find((t) => t.id === OWNER);
ship.provides = synced.map((m) => m.id);

registry.meta.moduleSync = {
  from: 'fmtventures/Financial-tool → studio/registry.js',
  at: new Date().toISOString().slice(0, 10),
  count: synced.length,
  wired: synced.filter((m) => m.wired).length,
};

writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + '\n', 'utf8');

const added = synced.filter((m) => !before.includes(m.id)).map((m) => m.id);
const removed = before.filter((id) => !synced.some((m) => m.id === id));

console.log(`Synced ${synced.length} modules from The Ship (${synced.filter((m) => m.wired).length} wired).`);
if (added.length) console.log(`  added:   ${added.join(', ')}`);
if (removed.length) console.log(`  removed: ${removed.join(', ')}`);
if (kept.length) console.log(`  kept ${kept.length} hand-written module(s): ${kept.map((m) => m.id).join(', ')}`);
if (staleConns.length) console.log(`  dropped ${staleConns.length} connection(s) to removed modules`);
console.log('\nRun `node dashboard/build.mjs` to rebuild.');
