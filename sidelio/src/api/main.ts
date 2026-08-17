import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_PAGES } from '../../tests/fixtures/site.ts';
import { createApp } from './server.ts';
import { seedStore } from './store.ts';

/** Dev entry point: `npm run dev`. */

const here = dirname(fileURLToPath(import.meta.url));
const adminDir = join(here, '..', 'admin');
const port = Number(process.env['PORT'] ?? 4310);

const store = await seedStore(FIXTURE_PAGES);
const server = createApp(store, adminDir);

server.listen(port, () => {
  const stats = store.graph.stats();
  console.log(`\n  Sidelio admin → http://localhost:${port}\n`);
  console.log(`  Seeded by running Smart Import against the fixture site:`);
  console.log(`    ${store.pages().length} pages generated`);
  console.log(`    ${stats.totalEntities} entities, ${stats.totalFacts} facts`);
  console.log(`    ${stats.pendingReview} facts awaiting review\n`);
});
