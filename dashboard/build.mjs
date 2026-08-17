/**
 * Inlines registry.json, styles.css and app.js into single-file builds.
 *
 *   node dashboard/build.mjs
 *
 * Produces:
 *   dist/index.html     full standalone page — open from disk or host on Pages
 *   dist/artifact.html  page content only, for publishing as a Claude Artifact
 *                       (the host supplies doctype/html/head/body)
 *
 * No dependencies. Run it after editing registry.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

const registryRaw = read('registry.json');
const css = read('styles.css');
const js = read('app.js');
const shell = read('index.html');

/* Fail loudly on malformed data rather than shipping a blank dashboard. */
let registry;
try {
  registry = JSON.parse(registryRaw);
} catch (err) {
  console.error('registry.json is not valid JSON:', err.message);
  process.exit(1);
}

for (const key of ['tools', 'modules', 'connections', 'clients', 'platforms']) {
  if (!Array.isArray(registry[key])) {
    console.error(`registry.json is missing the "${key}" array.`);
    process.exit(1);
  }
}

/* Referential integrity — a dangling id renders as a raw slug, so catch it here. */
const toolIds = new Set(registry.tools.map((t) => t.id));
const moduleIds = new Set(registry.modules.map((m) => m.id));
const warnings = [];

registry.connections.forEach((c, i) => {
  if (!moduleIds.has(c.moduleId)) warnings.push(`connections[${i}]: unknown moduleId "${c.moduleId}"`);
  if (!toolIds.has(c.toToolId)) warnings.push(`connections[${i}]: unknown toToolId "${c.toToolId}"`);
});
registry.tools.forEach((t) => {
  (t.provides || []).forEach((m) => { if (!moduleIds.has(m)) warnings.push(`${t.id}: provides unknown module "${m}"`); });
  (t.consumes || []).forEach((m) => { if (!moduleIds.has(m)) warnings.push(`${t.id}: consumes unknown module "${m}"`); });
});
registry.modules.forEach((m) => {
  if (m.ownerToolId && !toolIds.has(m.ownerToolId)) warnings.push(`module ${m.id}: unknown ownerToolId "${m.ownerToolId}"`);
});

if (warnings.length) {
  console.warn('\nRegistry warnings:');
  warnings.forEach((w) => console.warn('  - ' + w));
  console.warn('');
}

/* `</script>` inside JSON would close the host tag early. */
const safeJson = JSON.stringify(registry).replace(/<\//g, '<\\/');
const dataTag = `<script type="application/json" id="registry-data">${safeJson}</script>`;

/* Body markup, lifted out of the shell and stripped of its external references. */
const bodyInner = shell
  .slice(shell.indexOf('<body>') + '<body>'.length, shell.lastIndexOf('</body>'))
  .replace(/\s*<script src="app\.js"><\/script>/, '')
  .trim();

const styleTag = `<style>\n${css}\n</style>`;
const scriptTag = `<script>\n${js}\n</script>`;

const dist = join(here, 'dist');
mkdirSync(dist, { recursive: true });

/* --- full standalone page ------------------------------------------------- */
const standalone = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Build Board</title>
<meta name="description" content="Every tool FT Ventures is building, what state it is in, how the modules connect, and what to work on next.">
${styleTag}
</head>
<body>
${bodyInner}
${dataTag}
${scriptTag}
</body>
</html>
`;
writeFileSync(join(dist, 'index.html'), standalone);

/* --- artifact payload (no doctype/html/head/body) ------------------------- */
const artifact = `<title>Build Board</title>
${styleTag}
${bodyInner}
${dataTag}
${scriptTag}
`;
writeFileSync(join(dist, 'artifact.html'), artifact);

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log(`Built ${registry.tools.length} tools, ${registry.modules.length} modules, ${registry.connections.length} connections`);
console.log(`  dist/index.html     ${kb(standalone)}`);
console.log(`  dist/artifact.html  ${kb(artifact)}`);
if (warnings.length) console.log(`  ${warnings.length} warning(s) above`);
