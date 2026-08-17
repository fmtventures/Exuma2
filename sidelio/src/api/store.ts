import { SiteAssistant } from '../ai/assistant.ts';
import { ProviderRegistry } from '../ai/provider.ts';
import { MockTextProvider } from '../ai/providers/mock.ts';
import type { Navigation, Page } from '../blocks/page.ts';
import { Auditor, MemoryAuditSink } from '../core/audit.ts';
import {
  apply as applyChangeSet, MemoryDocumentStore, preview as previewChangeSet,
  revert as revertChangeSet, summarize, type ChangeSet, type ResourceRef,
} from '../core/changeset.ts';
import { err } from '../core/errors.ts';
import { asId, type OrgId, type SiteId, type UserId } from '../core/ids.ts';
import type { Actor } from '../core/permissions.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { Site } from '../core/tenancy.ts';
import { DEFAULT_BRAND_KIT, type BrandKit } from '../design/brand-kit.ts';
import { generateSite } from '../generate/site-plan.ts';
import { createAttestation } from '../import/authorization.ts';
import { StaticFetcher } from '../import/fetcher.ts';
import { buildKnowledgeGraph, runCrawl, type ImportJob } from '../import/pipeline.ts';
import { buildReview, type ImportReview, type PageDecision } from '../import/review.ts';
import { KnowledgeGraph } from '../knowledge/graph.ts';
import type { Asset } from '../media/asset.ts';
import { ingestImages, summarizeIngest, type IngestSummary } from '../media/ingest.ts';
import { MemoryObjectStore, type ObjectStore } from '../media/store.ts';

/**
 * In-memory application store.
 *
 * The persistent implementation is `src/db/schema.sql` — this is the same
 * interface backed by maps so the admin UI can be run, demonstrated and tested
 * without a database. Every mutation still goes through a ChangeSet, so
 * swapping in Postgres changes where documents live, not how they are edited.
 */

export const ORG_ID = asId<OrgId>('org_01SIDELIODEMOORG0000000000');
export const SITE_ID = asId<SiteId>('site_01SIDELIODEMOSITE00000000');
export const USER_ID = asId<UserId>('usr_01SIDELIODEMOUSER00000000');

export const DEV_ACTOR: Actor = {
  userId: USER_ID,
  isPlatformStaff: false,
  memberships: [{
    orgId: ORG_ID, userId: USER_ID, role: 'org_owner', siteIds: null,
    createdAt: new Date().toISOString(),
  }],
};

export interface SiteState {
  site: Site;
  brandKit: BrandKit;
  graph: KnowledgeGraph;
  navigation: Navigation[];
  importJob?: ImportJob;
  review?: ImportReview;
  changeSets: ChangeSet[];
  assets: Map<string, Asset>;
  storage: ObjectStore;
  ingestSummary?: IngestSummary;
}

const pageRef = (page: Page): ResourceRef => ({ type: 'page', id: page.id, label: page.title });

export class AppStore {
  readonly auditSink = new MemoryAuditSink();
  readonly auditor = new Auditor(this.auditSink);
  readonly assistant = new SiteAssistant(
    new ProviderRegistry().register('mock', { text: new MockTextProvider() }),
  );

  private documents = new MemoryDocumentStore();
  private state: SiteState;

  constructor(state: SiteState, pages: Page[]) {
    this.state = state;
    for (const page of pages) this.documents.put(pageRef(page), page);
  }

  get site() { return this.state.site; }
  get brandKit() { return this.state.brandKit; }
  get graph() { return this.state.graph; }
  get review() { return this.state.review; }
  get importJob() { return this.state.importJob; }
  get changeSets() { return this.state.changeSets; }
  get storage() { return this.state.storage; }
  get ingestSummary() { return this.state.ingestSummary; }

  /** Live assets, newest first. Archived ones are kept but not listed. */
  assets(): Asset[] {
    return [...this.state.assets.values()]
      .filter((a) => !a.archivedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  allAssets(): Asset[] {
    return [...this.state.assets.values()];
  }

  asset(id: string): Asset | undefined {
    return this.state.assets.get(id);
  }

  /** The map the renderer resolves `assetId` block references against. */
  assetMap(): Map<string, Asset> {
    return this.state.assets;
  }

  updateAsset(id: string, patch: Partial<Asset>): Asset | undefined {
    const existing = this.state.assets.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.state.assets.set(id, next);
    return next;
  }

  pages(): Page[] {
    return this.documents.entries()
      .filter(([key]) => key.startsWith('page:'))
      .map(([, doc]) => doc as Page)
      .sort((a, b) => a.order - b.order);
  }

  page(id: string): Page | undefined {
    return this.pages().find((p) => p.id === id);
  }

  /** Preview a change set against a sandbox copy — nothing is mutated. */
  previewChanges(cs: ChangeSet) {
    return previewChangeSet(this.documents, cs);
  }

  /** Commit a change set and record it in history. */
  applyChanges(cs: ChangeSet): Result<ChangeSet> {
    const result = applyChangeSet(this.documents, cs);
    if (!result.ok) return result;
    this.documents = result.value.store as MemoryDocumentStore;
    this.state.changeSets.unshift(result.value.changeSet);
    return ok(result.value.changeSet);
  }

  revertChanges(id: string): Result<ChangeSet> {
    const index = this.state.changeSets.findIndex((c) => c.id === id);
    const cs = this.state.changeSets[index];
    if (!cs) return fail(err('NOT_FOUND', `change set ${id} not found`));

    const result = revertChangeSet(this.documents, cs);
    if (!result.ok) return result;
    this.documents = result.value.store as MemoryDocumentStore;
    this.state.changeSets[index] = result.value.changeSet;
    return ok(result.value.changeSet);
  }

  setBrandKit(kit: BrandKit) {
    this.state.brandKit = kit;
  }

  /** Update an import review decision and recompute what would be built. */
  setPageDecision(url: string, decision: PageDecision): boolean {
    const item = this.state.review?.pages.find((p) => p.url === url);
    if (!item) return false;
    item.decision = decision;
    return true;
  }

  summarize = summarize;
}

/**
 * Seed the store by running the real import pipeline against the fixture site,
 * so the admin opens on a site that genuinely came through Smart Import rather
 * than hand-written sample data.
 */
export async function seedStore(
  fixtures: Record<string, { body?: string; binary?: Uint8Array; contentType?: string }>,
): Promise<AppStore> {
  const attested = createAttestation({
    orgId: ORG_ID, siteId: SITE_ID, attestedBy: USER_ID, basis: 'owner',
    hosts: ['acmeroofing.ca'], accepted: true,
  });
  if (!attested.ok) throw attested.error;

  const importJob = await runCrawl(
    { siteId: SITE_ID, attestation: attested.value, seeds: ['https://acmeroofing.ca/'], budget: { maxPages: 25, maxDepth: 2 } },
    { fetcher: new StaticFetcher(fixtures), sleep: async () => {} },
  );

  const graph = buildKnowledgeGraph(SITE_ID, importJob);
  const review = buildReview(importJob, graph);
  const generated = generateSite(SITE_ID, graph, { mode: 'industry_optimized' });

  // Download the images the review kept, so the media library and the
  // renderer's assetId path have real data rather than an empty map.
  const storage = new MemoryObjectStore();
  const ingest = await ingestImages(review, {
    fetcher: new StaticFetcher(fixtures),
    storage,
    siteId: SITE_ID,
    attestation: attested.value,
    uploadedBy: USER_ID,
  });

  const site: Site = {
    id: SITE_ID,
    orgId: ORG_ID,
    name: 'Acme Roofing Ltd.',
    subdomain: 'acme-roofing',
    status: 'draft',
    enabledModules: ['pages', 'navigation', 'media', 'content', 'forms', 'seo', 'ai_studio'],
    brandLocked: false,
    locale: 'en',
    additionalLocales: [],
    createdAt: new Date().toISOString(),
  };

  // Link each page's largest ingested image into its hero block. Without this
  // the generated blocks carry no assetId, the renderer's asset branch stays
  // unreachable, and imported media would sit in the library doing nothing.
  const pages = attachHeroImages(generated.pages, ingest.assets, review);

  return new AppStore(
    {
      site,
      brandKit: structuredClone(DEFAULT_BRAND_KIT),
      graph,
      navigation: generated.navigation,
      importJob,
      review,
      changeSets: [],
      assets: new Map(ingest.assets.map((a) => [a.id, a])),
      storage,
      ingestSummary: summarizeIngest(ingest),
    },
    pages,
  );
}

/**
 * Attach imported imagery to the pages it came from.
 *
 * The review already records which pages used each image, so a page's hero
 * gets the largest image that actually appeared on it rather than an arbitrary
 * one from the library. Pages whose source had no usable image keep an empty
 * slot — inventing an unrelated stock photo would be worse than a blank.
 */
function attachHeroImages(pages: Page[], assets: Asset[], review: ImportReview): Page[] {
  if (assets.length === 0) return pages;

  const bySourceUrl = new Map(assets.map((a) => [a.rights.source ?? '', a]));
  const largest = [...assets].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];

  return pages.map((page) => {
    const heroIndex = page.blocks.findIndex((b) => b.type === 'hero');
    if (heroIndex === -1) return page;

    // Prefer an image the source page actually used; fall back to the largest.
    const used = review.assets
      .filter((item) => item.usedOnPages.some((u) => u.endsWith(page.path) || page.path === '/'))
      .map((item) => bySourceUrl.get(item.url))
      .filter((a): a is Asset => a !== undefined)
      .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));

    const chosen = used[0] ?? largest;
    if (!chosen) return page;

    const blocks = [...page.blocks];
    const hero = blocks[heroIndex] as Page['blocks'][number];
    blocks[heroIndex] = {
      ...hero,
      props: {
        ...hero.props,
        image: {
          assetId: chosen.id,
          ...(chosen.altText ? { alt: chosen.altText } : {}),
        },
      },
    };
    return { ...page, blocks };
  });
}

export function emptyGraph(): KnowledgeGraph {
  return new KnowledgeGraph(SITE_ID);
}
