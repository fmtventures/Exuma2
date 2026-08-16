/**
 * Journey A, runnable: `npm run demo`
 *
 * Takes a fixture website through the whole pipeline — attestation, crawl,
 * extraction, knowledge graph, review, generation, assistant edit, render —
 * and prints what happened at each stage. Writes the generated homepage to
 * `dist/demo/index.html` so the output can be opened in a browser.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SiteAssistant } from '../ai/assistant.ts';
import { ProviderRegistry } from '../ai/provider.ts';
import { MockTextProvider } from '../ai/providers/mock.ts';
import { apply, describeImpact, MemoryDocumentStore, summarize } from '../core/changeset.ts';
import { asId, type OrgId, type SiteId, type UserId } from '../core/ids.ts';
import { approve } from '../core/provenance.ts';
import { DEFAULT_BRAND_KIT } from '../design/brand-kit.ts';
import { detectIndustry, generateSite } from '../generate/site-plan.ts';
import { createAttestation } from '../import/authorization.ts';
import { StaticFetcher } from '../import/fetcher.ts';
import { buildKnowledgeGraph, runCrawl } from '../import/pipeline.ts';
import { buildRedirectMap, buildReview, summaryLines } from '../import/review.ts';
import { renderPage } from '../render/html.ts';
import { renderHead } from '../render/seo.ts';
import { FIXTURE_PAGES } from '../../tests/fixtures/site.ts';

const ORG = asId<OrgId>('org_demo');
const SITE = asId<SiteId>('site_demo');
const USER = asId<UserId>('usr_demo');

const heading = (text: string) => {
  console.log(`\n${'─'.repeat(68)}\n${text}\n${'─'.repeat(68)}`);
};

async function main() {
  heading('1. Attestation — no crawl runs without recorded permission');

  const attested = createAttestation({
    orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner',
    hosts: ['acmeroofing.ca'], accepted: true,
  });
  if (!attested.ok) throw attested.error;
  console.log(`  basis:  ${attested.value.basis}`);
  console.log(`  hosts:  ${attested.value.hosts.join(', ')}`);

  const denied = createAttestation({
    orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner',
    hosts: ['acmeroofing.ca'], accepted: false,
  });
  console.log(`  without acceptance: ${denied.ok ? 'allowed' : `refused — ${denied.error.code}`}`);

  heading('2. Crawl');

  const job = await runCrawl(
    { siteId: SITE, attestation: attested.value, seeds: ['https://acmeroofing.ca/'], budget: { maxPages: 25, maxDepth: 2 } },
    { fetcher: new StaticFetcher(FIXTURE_PAGES), sleep: async () => {} },
  );
  const byStatus = job.outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  status: ${job.status}`);
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  ${status.padEnd(16)} ${count}`);
  }

  heading('3. Knowledge graph');

  const graph = buildKnowledgeGraph(SITE, job);
  const stats = graph.stats();
  for (const [type, count] of Object.entries(stats.entitiesByType).sort()) {
    console.log(`  ${type.padEnd(16)} ${count}`);
  }
  console.log(`\n  facts: ${stats.totalFacts}   publishable: ${stats.publishable}   ` +
    `awaiting review: ${stats.pendingReview}   conflicts: ${stats.conflicts}`);

  heading('4. Review — "We found:"');

  const review = buildReview(job, graph);
  for (const line of summaryLines(review.summary)) console.log(`  ${line}`);

  console.log('\n  Recommended decisions:');
  for (const p of review.pages) {
    console.log(`  ${p.decision.padEnd(9)} ${p.url.replace('https://acmeroofing.ca', '') || '/'}`);
  }

  console.log('\n  Migration warnings:');
  for (const w of review.warnings) {
    console.log(`  [${w.severity}] ${w.message}`);
  }
  console.log(`\n  ${buildRedirectMap(review).length} redirect(s) will be created to preserve search rankings.`);

  heading('5. Generate');

  const industry = detectIndustry(graph);
  console.log(`  detected industry: ${industry}`);

  let site = generateSite(SITE, graph, { mode: 'industry_optimized' });
  for (const note of site.notes) console.log(`  · ${note}`);
  console.log('');
  for (const page of site.pages) {
    console.log(`  ${page.path.padEnd(12)} ${page.blocks.map((b) => b.type).join(' → ')}`);
  }
  if (site.missing.length > 0) {
    console.log('\n  Missing facts limiting the build:');
    for (const m of site.missing) console.log(`  · ${m.label}: ${m.impact}`);
  }

  heading('6. The publish gate — unverified facts stay off the site');

  const melissa = graph.byType('Employee').find((e) => e['name'] === 'Melissa Doyle');
  console.log(`  "Melissa Doyle" was extracted from the team page.`);
  console.log(`  Team members on the generated site before review: ` +
    `${countTeamMembers(site)}  (heuristic extraction — not yet approved)`);

  if (melissa) {
    const fact = graph.getFact(melissa.id, 'name');
    if (fact) graph.replaceFact(melissa.id, 'name', approve(fact, USER));
  }
  site = generateSite(SITE, graph, { mode: 'industry_optimized' });
  console.log(`  Team members after a human approves one:            ${countTeamMembers(site)}`);

  heading('7. AI assistant — preview before apply');

  const assistant = new SiteAssistant(new ProviderRegistry().register('mock', { text: new MockTextProvider() }));
  const plan = await assistant.plan({
    intent: 'Change all phone numbers to 902-555-9876',
    actorId: USER,
    state: {
      siteId: SITE, pages: site.pages, brandKit: DEFAULT_BRAND_KIT,
      siteContext: { businessName: 'Acme Roofing Ltd.', industry },
    },
  });
  if (!plan.ok) throw plan.error;

  console.log(`  strategy: ${plan.value.strategy}`);
  console.log(`  ${plan.value.explanation}\n`);
  console.log('  WHAT WILL CHANGE');
  for (const line of describeImpact(summarize(plan.value.changeSet))) console.log(`  - ${line}`);
  console.log('\n  [PREVIEW]  [APPLY]  [CANCEL]');

  const store = MemoryDocumentStore.from(
    site.pages.map((p) => [{ type: 'page' as const, id: p.id, label: p.title }, p]),
  );
  const applied = apply(store, plan.value.changeSet);
  if (!applied.ok) throw applied.error;
  console.log(`\n  applied — ${applied.value.changeSet.inverse?.length ?? 0} inverse operations stored for undo`);

  heading('8. Render');

  const home = site.pages.find((p) => p.path === '/');
  if (!home) throw new Error('no homepage was generated');

  const html = renderPage(
    { page: home, brandKit: DEFAULT_BRAND_KIT, assets: new Map(), origin: 'https://acmeroofing.ca' },
    { head: renderHead({ page: home, origin: 'https://acmeroofing.ca', graph, siteName: 'Acme Roofing Ltd.' }) },
  );

  const out = resolve(process.cwd(), 'dist/demo/index.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, 'utf8');

  console.log(`  ${(html.length / 1024).toFixed(1)} KB written to ${out}`);
  console.log(`  structured data: ${(html.match(/application\/ld\+json/g) ?? []).length} block(s)`);
  console.log(`  h1 elements:     ${(html.match(/<h1/g) ?? []).length}`);
  console.log(`  images missing an alt attribute: ${(html.match(/<img(?![^>]*\balt=)/g) ?? []).length}`);
  console.log('');
}

function countTeamMembers(site: ReturnType<typeof generateSite>): number {
  const team = site.pages.flatMap((p) => p.blocks).find((b) => b.type === 'team');
  return ((team?.props['members'] as unknown[]) ?? []).length;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
