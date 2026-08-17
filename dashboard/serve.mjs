/**
 * Local server for the Build Board.
 *
 *   node dashboard/serve.mjs          → http://127.0.0.1:4321
 *   node dashboard/serve.mjs --port 8080
 *
 * Running this way is the difference between a read-only page and a real tool:
 * the dashboard detects the local API and edits save directly into
 * registry.json instead of going through the copy-and-paste patch loop.
 *
 * Binds to 127.0.0.1 only — nothing is exposed to the network. No dependencies.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(here, 'registry.json');

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = portArg !== -1 ? Number(argv[portArg + 1]) : 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* Only these files are writable, and only registry.json via the API. */
const SERVE_ROOT = here;

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Structural check, so a malformed POST can never blank the registry. */
function validateRegistry(obj) {
  if (!obj || typeof obj !== 'object') return 'not an object';
  for (const key of ['tools', 'modules', 'connections', 'clients', 'platforms']) {
    if (!Array.isArray(obj[key])) return `missing the "${key}" array`;
  }
  if (!obj.tools.length) return 'tools array is empty';
  if (obj.tools.some((t) => !t || typeof t.id !== 'string' || !t.id)) return 'every tool needs a string id';
  const ids = obj.tools.map((t) => t.id);
  if (new Set(ids).size !== ids.length) return 'duplicate tool ids';
  return null;
}

function rebuild() {
  const child = spawn(process.execPath, [join(here, 'build.mjs')], { stdio: 'ignore' });
  child.on('error', () => { /* the save already succeeded; a failed rebuild is not fatal */ });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const path = url.pathname;

  /* ---- API ------------------------------------------------------------- */
  if (path === '/api/health') {
    return sendJson(res, 200, { local: true, writable: existsSync(REGISTRY), registry: 'registry.json' });
  }

  if (path === '/api/registry' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      let incoming;
      try { incoming = JSON.parse(raw); }
      catch (e) { return sendJson(res, 400, { ok: false, error: 'Body is not valid JSON: ' + e.message }); }

      const problem = validateRegistry(incoming);
      if (problem) return sendJson(res, 400, { ok: false, error: 'Refused to save — registry ' + problem });

      /* Keep one step of undo on disk before overwriting. */
      try { await copyFile(REGISTRY, REGISTRY + '.bak'); } catch { /* first run */ }

      incoming.meta = incoming.meta || {};
      incoming.meta.updated = new Date().toISOString().slice(0, 10);

      await writeFile(REGISTRY, JSON.stringify(incoming, null, 2) + '\n', 'utf8');
      rebuild();

      return sendJson(res, 200, {
        ok: true,
        savedAt: new Date().toISOString(),
        tools: incoming.tools.length,
        backup: 'registry.json.bak',
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (path.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });

  /* ---- static ---------------------------------------------------------- */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD, POST' });
    return res.end('Method not allowed');
  }

  const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
  const full = normalize(join(SERVE_ROOT, rel));

  /* Never serve outside the dashboard folder. */
  if (!full.startsWith(SERVE_ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  try {
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found: ' + rel);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Build Board running locally`);
  console.log(`  →  http://127.0.0.1:${PORT}\n`);
  console.log(`  Edits save straight into dashboard/registry.json.`);
  console.log(`  The previous version is kept as registry.json.bak on every save.`);
  console.log(`  Ctrl+C to stop.\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try:  node dashboard/serve.mjs --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw err;
});
