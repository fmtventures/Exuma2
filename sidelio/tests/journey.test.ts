import { describe, expect, it } from 'vitest';
import { SiteAssistant } from '../src/ai/assistant.ts';
import { ProviderRegistry } from '../src/ai/provider.ts';
import { MockTextProvider } from '../src/ai/providers/mock.ts';
import { apply, MemoryDocumentStore, readPath } from '../src/core/changeset.ts';
import { asId, type OrgId, type SiteId, type UserId } from '../src/core/ids.ts';
import { Auditor, MemoryAuditSink } from '../src/core/audit.ts';
import { assertCan } from '../src/core/permissions.ts';
import { approve } from '../src/core/provenance.ts';
import { DEFAULT_BRAND_KIT } from '../src/design/brand-kit.ts';
import { detectIndustry, generateSite, generateThreeConcepts } from '../src/generate/site-plan.ts';
import { createAttestation } from '../src/import/authorization.ts';
import { StaticFetcher } from '../src/import/fetcher.ts';
import { buildKnowledgeGraph, runCrawl } from '../src/import/pipeline.ts';
import { buildRedirectMap, buildReview, selectedPages, summaryLines } from '../src/import/review.ts';
import { renderPage } from '../src/render/html.ts';
import { auditPageSeo, renderHead, renderSitemap } from '../src/render/seo.ts';
import { FIXTURE_PAGES } from './fixtures/site.ts';

/**
 * Journey A end to end: a business owner types their existing website address
 * and ends up with a generated, publishable Sidelio site.
 *
 * This is the test that proves the modules actually compose — it is easy for
 * each layer to pass in isolation and still not fit together.
 */

const ORG = asId<OrgId>('org_1');
const SITE = asId<SiteId>('site_1');
const USER = asId<UserId>('usr_1');

const ownerActor = {
  userId: USER,
  isPlatformStaff: false,
  memberships: [{ orgId: ORG, userId: USER, role: 'org_owner' as const, siteIds: null, createdAt: '2026-01-01T00:00:00Z' }],
};

describe('Journey A — rebuild an existing website', () => {
  it('runs from URL to rendered, SEO-complete site', async () => {
    const audit = new MemoryAuditSink();
    const auditor = new Auditor(audit);

    // 1. Permission and attestation ------------------------------------
    assertCan(ownerActor, 'import:create', { orgId: ORG, siteId: SITE });

    const attested = createAttestation({
      orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner',
      hosts: ['acmeroofing.ca'], accepted: true,
    });
    expect(attested.ok).toBe(true);
    if (!attested.ok) return;

    await auditor.record({
      orgId: ORG, siteId: SITE, actorId: USER, category: 'import',
      action: 'import.attest', outcome: 'success', permission: 'import:create',
      metadata: { hosts: attested.value.hosts.join(','), basis: attested.value.basis },
    });

    // 2. Crawl ----------------------------------------------------------
    const job = await runCrawl(
      { siteId: SITE, attestation: attested.value, seeds: ['https://acmeroofing.ca/'], budget: { maxPages: 20, maxDepth: 2 } },
      { fetcher: new StaticFetcher(FIXTURE_PAGES), sleep: async () => {} },
    );
    expect(job.status).toBe('ready_for_review');

    // 3. Knowledge graph and review -------------------------------------
    const graph = buildKnowledgeGraph(SITE, job);
    const review = buildReview(job, graph);

    expect(summaryLines(review.summary).length).toBeGreaterThan(3);
    expect(review.summary.pages).toBeGreaterThanOrEqual(4);
    expect(selectedPages(review).length).toBeGreaterThan(0);

    // Redirects for every kept URL — the biggest SEO risk in a migration.
    const redirects = buildRedirectMap(review);
    expect(redirects.length).toBe(selectedPages(review).length);
    expect(redirects.every((r) => r.status === 301)).toBe(true);

    // 4. Industry detection ---------------------------------------------
    expect(detectIndustry(graph)).toBe('trades');

    // 5. Generate --------------------------------------------------------
    const generated = generateSite(SITE, graph, { mode: 'industry_optimized' });
    expect(generated.pages.length).toBeGreaterThanOrEqual(3);

    const home = generated.pages.find((p) => p.path === '/');
    expect(home).toBeDefined();
    if (!home) return;

    // The business name came from JSON-LD, so it is publishable and used.
    expect(home.blocks[0]?.props['heading']).toBe('Acme Roofing Ltd.');

    // Testimonials were extracted heuristically, so they sit in the review
    // queue and no testimonials block is emitted. Publishing a mis-attributed
    // quote from a real customer is exactly what the publish gate prevents.
    expect(graph.byType('Testimonial')).toHaveLength(2);
    expect(home.blocks.find((b) => b.type === 'testimonials')).toBeUndefined();
    expect(review.warnings.some((w) => w.code === 'unverified_facts')).toBe(true);

    // A phone-number CTA exists because the phone cleared the publish gate.
    const cta = generated.pages.flatMap((p) => p.blocks).find((b) => b.type === 'cta');
    const buttons = cta?.props['buttons'] as Array<{ href: string }>;
    expect(buttons.some((b) => b.href.startsWith('tel:'))).toBe(true);

    // 6. Render ----------------------------------------------------------
    const head = renderHead({
      page: home, origin: 'https://acmeroofing.ca', graph, siteName: 'Acme Roofing Ltd.',
    });
    expect(head).toContain('LocalBusiness');
    expect(head).toContain('"telephone":"902-555-1234"');

    const html = renderPage(
      { page: home, brandKit: DEFAULT_BRAND_KIT, assets: new Map(), origin: 'https://acmeroofing.ca' },
      { head },
    );
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Acme Roofing Ltd.');
    expect(html).toContain('Skip to content');
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(html).not.toContain('undefined');

    // 7. Sitemap ---------------------------------------------------------
    const sitemap = renderSitemap('https://acmeroofing.ca', generated.pages.map((p) => ({ ...p, status: 'published' as const })));
    expect(sitemap).toContain('<loc>https://acmeroofing.ca/</loc>');

    expect(audit.find('import.attest')).toHaveLength(1);
  });

  it('leaves unverified facts off the generated site and reports them', async () => {
    const job = await runCrawl(
      { siteId: SITE, attestation: (() => {
        const a = createAttestation({ orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner', hosts: ['acmeroofing.ca'], accepted: true });
        if (!a.ok) throw new Error('setup');
        return a.value;
      })(), seeds: ['https://acmeroofing.ca/'], budget: { maxPages: 20, maxDepth: 2 } },
      { fetcher: new StaticFetcher(FIXTURE_PAGES), sleep: async () => {} },
    );
    const graph = buildKnowledgeGraph(SITE, job);

    // Team members are heuristic guesses — they must not be publishable yet.
    const melissa = graph.byType('Employee').find((e) => e['name'] === 'Melissa Doyle');
    expect(melissa).toBeDefined();
    if (!melissa) return;

    const before = generateSite(SITE, graph, { mode: 'industry_optimized' });
    const teamBefore = before.pages.flatMap((p) => p.blocks).find((b) => b.type === 'team');
    expect((teamBefore?.props['members'] as unknown[] | undefined) ?? []).toHaveLength(0);

    // Once a human approves the name, the person appears.
    const fact = graph.getFact(melissa.id, 'name');
    if (!fact) throw new Error('no fact');
    graph.replaceFact(melissa.id, 'name', approve(fact, USER));

    const after = generateSite(SITE, graph, { mode: 'industry_optimized' });
    const teamAfter = after.pages.flatMap((p) => p.blocks).find((b) => b.type === 'team');
    const members = (teamAfter?.props['members'] as Array<{ name: string }>) ?? [];
    expect(members.map((m) => m.name)).toContain('Melissa Doyle');
  });

  it('produces three genuinely different concepts', async () => {
    const job = await runCrawl(
      { siteId: SITE, attestation: (() => {
        const a = createAttestation({ orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner', hosts: ['acmeroofing.ca'], accepted: true });
        if (!a.ok) throw new Error('setup');
        return a.value;
      })(), seeds: ['https://acmeroofing.ca/'], budget: { maxPages: 10, maxDepth: 1 } },
      { fetcher: new StaticFetcher(FIXTURE_PAGES), sleep: async () => {} },
    );
    const graph = buildKnowledgeGraph(SITE, job);
    const concepts = generateThreeConcepts(SITE, graph, { mode: 'redesign' });

    const heroHeight = (site: typeof concepts.bold) =>
      site.pages.find((p) => p.path === '/')?.blocks[0]?.props['height'];

    expect(heroHeight(concepts.conservative)).toBe('medium');
    expect(heroHeight(concepts.modern)).toBe('large');
    expect(heroHeight(concepts.bold)).toBe('viewport');
  });

  it('performance_first mode refuses to emit the blocks that hurt page speed', async () => {
    const job = await runCrawl(
      { siteId: SITE, attestation: (() => {
        const a = createAttestation({ orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner', hosts: ['acmeroofing.ca'], accepted: true });
        if (!a.ok) throw new Error('setup');
        return a.value;
      })(), seeds: ['https://acmeroofing.ca/'], budget: { maxPages: 10, maxDepth: 1 } },
      { fetcher: new StaticFetcher(FIXTURE_PAGES), sleep: async () => {} },
    );
    const graph = buildKnowledgeGraph(SITE, job);
    const site = generateSite(SITE, graph, { mode: 'performance_first' });
    const types = site.pages.flatMap((p) => p.blocks.map((b) => b.type));
    expect(types).not.toContain('social_feed');
    expect(types).not.toContain('gallery');
    expect(types).not.toContain('video');
  });

  it('generated pages pass their own SEO audit for the things generation controls', async () => {
    const job = await runCrawl(
      { siteId: SITE, attestation: (() => {
        const a = createAttestation({ orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner', hosts: ['acmeroofing.ca'], accepted: true });
        if (!a.ok) throw new Error('setup');
        return a.value;
      })(), seeds: ['https://acmeroofing.ca/'], budget: { maxPages: 20, maxDepth: 2 } },
      { fetcher: new StaticFetcher(FIXTURE_PAGES), sleep: async () => {} },
    );
    const graph = buildKnowledgeGraph(SITE, job);
    const site = generateSite(SITE, graph, { mode: 'industry_optimized' });

    for (const page of site.pages) {
      const codes = auditPageSeo(page).map((i) => i.code);
      expect(codes, page.path).not.toContain('missing_title');
      expect(codes, page.path).not.toContain('missing_description');
      expect(codes, page.path).not.toContain('multiple_h1');
      expect(codes, page.path).not.toContain('missing_h1');
    }
  });

  it('the assistant can edit the generated site and the change is reversible', async () => {
    const job = await runCrawl(
      { siteId: SITE, attestation: (() => {
        const a = createAttestation({ orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner', hosts: ['acmeroofing.ca'], accepted: true });
        if (!a.ok) throw new Error('setup');
        return a.value;
      })(), seeds: ['https://acmeroofing.ca/'], budget: { maxPages: 20, maxDepth: 2 } },
      { fetcher: new StaticFetcher(FIXTURE_PAGES), sleep: async () => {} },
    );
    const graph = buildKnowledgeGraph(SITE, job);
    const site = generateSite(SITE, graph, { mode: 'industry_optimized' });

    const assistant = new SiteAssistant(new ProviderRegistry().register('mock', { text: new MockTextProvider() }));
    const plan = await assistant.plan({
      intent: 'Change all phone numbers to 902-555-9876',
      actorId: USER,
      state: { siteId: SITE, pages: site.pages, brandKit: DEFAULT_BRAND_KIT, siteContext: { businessName: 'Acme Roofing Ltd.' } },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.impact.join(', ')).toMatch(/page/);

    const store = MemoryDocumentStore.from(
      site.pages.map((p) => [{ type: 'page' as const, id: p.id, label: p.title }, p]),
    );
    const applied = apply(store, plan.value.changeSet);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const homeId = site.pages.find((p) => p.path === '/')?.id as string;
    const updated = applied.value.store.get({ type: 'page', id: homeId });
    const json = JSON.stringify(readPath(updated, 'blocks'));
    expect(json).toContain('9025559876');
    expect(json).not.toContain('9025551234');
    expect(applied.value.changeSet.inverse?.length).toBe(plan.value.changeSet.operations.length);
  });
});
