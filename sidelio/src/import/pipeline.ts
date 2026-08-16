import { newId, type ImportJobId, type SiteId } from '../core/ids.ts';
import type { SourceRef } from '../core/provenance.ts';
import { KnowledgeGraph } from '../knowledge/graph.ts';
import { assertCovers, type ImportAttestation } from './authorization.ts';
import { crawlableLinks, extractPage, type ExtractedPage } from './extract/html.ts';
import {
  MAPPED_TYPES, readBusinessNode, readPostalAddress, type StructuredNode,
} from './extract/schema-org.ts';
import type { Fetcher } from './fetcher.ts';
import { isAllowed, parseRobots, PERMISSIVE_POLICY, type RobotsPolicy } from './robots.ts';

/**
 * Smart Import pipeline.
 *
 * discover → crawl → extract → build knowledge graph → review.
 *
 * Every stage is resumable and every page is independent, so a job that hits a
 * broken page reports it and keeps going. Nothing is written to the live site:
 * the output is a knowledge graph plus a review model that the user acts on.
 */

export type ImportJobStatus = 'pending' | 'crawling' | 'extracting' | 'ready_for_review' | 'applied' | 'failed' | 'cancelled';

export interface ImportBudget {
  maxPages: number;
  maxDepth: number;
  /** Politeness delay; raised to match robots.txt crawl-delay when present. */
  delayMs: number;
  maxDurationMs: number;
}

export const DEFAULT_BUDGET: ImportBudget = {
  maxPages: 200,
  maxDepth: 4,
  delayMs: 250,
  maxDurationMs: 10 * 60 * 1000,
};

export interface PageOutcome {
  url: string;
  depth: number;
  status: 'extracted' | 'skipped_robots' | 'skipped_budget' | 'unreachable' | 'not_html' | 'error';
  httpStatus?: number;
  message?: string;
  page?: ExtractedPage;
}

export interface ImportJob {
  id: ImportJobId;
  siteId: SiteId;
  status: ImportJobStatus;
  attestation: ImportAttestation;
  seeds: string[];
  budget: ImportBudget;
  startedAt: string;
  finishedAt?: string;
  outcomes: PageOutcome[];
  robotsOverride: boolean;
}

export interface CrawlDeps {
  fetcher: Fetcher;
  /** Injectable so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function originOf(url: string): string {
  return new URL(url).origin;
}

/** Fetch and parse robots.txt for each origin we are about to touch. */
async function loadRobots(origins: string[], deps: CrawlDeps): Promise<Map<string, RobotsPolicy>> {
  const map = new Map<string, RobotsPolicy>();
  for (const origin of origins) {
    const res = await deps.fetcher.get(`${origin}/robots.txt`);
    map.set(origin, res.ok && res.value.status === 200 ? parseRobots(res.value.body) : PERMISSIVE_POLICY);
  }
  return map;
}

/** Pull `<loc>` entries out of a sitemap (or sitemap index) document. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1] as string);
  const isIndex = /<sitemapindex/i.test(xml);
  return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

async function discoverFromSitemaps(
  origins: string[],
  robots: Map<string, RobotsPolicy>,
  deps: CrawlDeps,
  limit: number,
): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [];

  for (const origin of origins) {
    const declared = robots.get(origin)?.sitemaps ?? [];
    queue.push(...(declared.length > 0 ? declared : [`${origin}/sitemap.xml`]));
  }

  const visited = new Set<string>();
  while (queue.length > 0 && found.length < limit) {
    const next = queue.shift() as string;
    if (visited.has(next)) continue;
    visited.add(next);

    const res = await deps.fetcher.get(next);
    if (!res.ok || res.value.status !== 200) continue;
    const parsed = parseSitemap(res.value.body);
    found.push(...parsed.urls);
    // Bound index expansion so a huge sitemap index cannot stall discovery.
    queue.push(...parsed.sitemaps.slice(0, 20));
  }
  return found.slice(0, limit);
}

export async function runCrawl(
  input: {
    siteId: SiteId;
    attestation: ImportAttestation;
    seeds: string[];
    budget?: Partial<ImportBudget>;
    robotsOverride?: boolean;
  },
  deps: CrawlDeps,
): Promise<ImportJob> {
  const budget = { ...DEFAULT_BUDGET, ...input.budget };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const startedAtMs = now();

  const job: ImportJob = {
    id: newId('importJob') as ImportJobId,
    siteId: input.siteId,
    status: 'crawling',
    attestation: input.attestation,
    seeds: input.seeds,
    budget,
    startedAt: new Date(startedAtMs).toISOString(),
    outcomes: [],
    robotsOverride: input.robotsOverride ?? false,
  };

  // Refuse any seed the attestation does not cover, before touching the network.
  for (const seed of input.seeds) {
    const covered = assertCovers(input.attestation, seed);
    if (!covered.ok) {
      job.status = 'failed';
      job.finishedAt = new Date(now()).toISOString();
      job.outcomes.push({ url: seed, depth: 0, status: 'error', message: covered.error.userMessage });
      return job;
    }
  }

  const origins = [...new Set(input.seeds.map(originOf))];
  const robots = await loadRobots(origins, deps);
  const crawlDelay = Math.max(
    budget.delayMs,
    ...origins.map((o) => (robots.get(o)?.crawlDelaySeconds ?? 0) * 1000),
  );

  const sitemapUrls = await discoverFromSitemaps(origins, robots, deps, budget.maxPages);

  const queue: Array<{ url: string; depth: number }> = [
    ...input.seeds.map((url) => ({ url, depth: 0 })),
    ...sitemapUrls.map((url) => ({ url, depth: 1 })),
  ];
  const seen = new Set<string>(queue.map((q) => normalizeUrl(q.url)));
  let extracted = 0;

  while (queue.length > 0) {
    const item = queue.shift() as { url: string; depth: number };

    if (extracted >= budget.maxPages) {
      job.outcomes.push({ url: item.url, depth: item.depth, status: 'skipped_budget', message: `page limit of ${budget.maxPages} reached` });
      continue;
    }
    if (now() - startedAtMs > budget.maxDurationMs) {
      job.outcomes.push({ url: item.url, depth: item.depth, status: 'skipped_budget', message: 'time limit reached' });
      continue;
    }
    if (!assertCovers(input.attestation, item.url).ok) continue;

    const policy = robots.get(originOf(item.url)) ?? PERMISSIVE_POLICY;
    if (!job.robotsOverride && !isAllowed(policy, item.url)) {
      job.outcomes.push({ url: item.url, depth: item.depth, status: 'skipped_robots', message: 'disallowed by robots.txt' });
      continue;
    }

    const res = await deps.fetcher.get(item.url);
    if (!res.ok) {
      job.outcomes.push({ url: item.url, depth: item.depth, status: 'unreachable', message: res.error.userMessage });
      continue;
    }
    const response = res.value;
    if (response.status >= 400) {
      job.outcomes.push({ url: item.url, depth: item.depth, status: 'unreachable', httpStatus: response.status, message: `HTTP ${response.status}` });
      continue;
    }
    if (!response.contentType.includes('html')) {
      job.outcomes.push({ url: item.url, depth: item.depth, status: 'not_html', httpStatus: response.status, message: response.contentType });
      continue;
    }

    try {
      const page = extractPage(response.body, response.url);
      job.outcomes.push({ url: item.url, depth: item.depth, status: 'extracted', httpStatus: response.status, page });
      extracted += 1;

      if (item.depth < budget.maxDepth) {
        for (const link of crawlableLinks(page)) {
          const key = normalizeUrl(link);
          if (seen.has(key)) continue;
          seen.add(key);
          queue.push({ url: link, depth: item.depth + 1 });
        }
      }
    } catch (cause) {
      job.outcomes.push({
        url: item.url,
        depth: item.depth,
        status: 'error',
        message: cause instanceof Error ? cause.message : 'extraction failed',
      });
    }

    if (queue.length > 0 && crawlDelay > 0) await sleep(crawlDelay);
  }

  job.status = job.outcomes.some((o) => o.status === 'extracted') ? 'ready_for_review' : 'failed';
  job.finishedAt = new Date(now()).toISOString();
  return job;
}

function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    // Trailing-slash and index.html variants are the same page.
    url.pathname = url.pathname.replace(/\/index\.html?$/i, '/').replace(/(.)\/$/, '$1');
    // Common tracking params never change the page.
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']) {
      url.searchParams.delete(p);
    }
    return url.toString().toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/* ------------------------------------------------------------------ */
/* Graph construction                                                  */
/* ------------------------------------------------------------------ */

function sourceFor(url: string, fragment?: string): SourceRef {
  return {
    kind: 'website_crawl',
    locator: url,
    ...(fragment ? { fragment } : {}),
    retrievedAt: new Date().toISOString(),
  };
}

function structuredSource(url: string): SourceRef {
  return { kind: 'structured_data', locator: url, fragment: 'ld+json', retrievedAt: new Date().toISOString() };
}

/**
 * Fold crawled pages into a knowledge graph. Structured data is applied first
 * so its high-confidence values occupy the primary slot and heuristic findings
 * become alternatives rather than the other way round.
 */
export function buildKnowledgeGraph(siteId: SiteId, job: ImportJob): KnowledgeGraph {
  const graph = new KnowledgeGraph(siteId);
  const pages = job.outcomes.filter((o) => o.status === 'extracted' && o.page).map((o) => o.page as ExtractedPage);
  if (pages.length === 0) return graph;

  const homeUrl = pages.find((p) => p.pageKind === 'home')?.url ?? pages[0]?.url ?? '';

  // --- Pass 1: structured data ---------------------------------------
  let businessId: string | undefined;
  for (const page of pages) {
    for (const node of page.structuredData) {
      const mapped = MAPPED_TYPES[node.type];
      if (!mapped) continue;
      const src = structuredSource(page.url);

      if (mapped === 'Business') {
        const fields = readBusinessNode(node);
        const payload: Record<string, unknown> = {
          name: fields.name ?? 'Business',
          description: fields.description,
          websiteUrl: fields.url ?? homeUrl,
        };
        const result = graph.upsertEntity('Business', prune(payload), src, {
          ...(businessId ? { id: businessId } : { dedupeKey: 'primary' }),
        });
        if (result.ok) {
          businessId = result.value.id;
          applyBusinessSideEffects(graph, businessId, fields, node, src);
        }
      } else if (mapped === 'Employee' && typeof node.data['name'] === 'string') {
        graph.upsertEntity('Employee', prune({
          name: node.data['name'],
          role: str(node.data['jobTitle']),
          email: str(node.data['email'])?.replace(/^mailto:/i, ''),
          phone: str(node.data['telephone']),
          bio: str(node.data['description']),
        }), src, { dedupeKey: slug(String(node.data['name'])) });
      } else if (mapped === 'Product' && typeof node.data['name'] === 'string') {
        graph.upsertEntity('Product', prune({
          name: node.data['name'],
          sku: str(node.data['sku']),
          description: str(node.data['description']),
          price: readOffer(node),
        }), src, { dedupeKey: slug(String(node.data['name'])) });
      } else if (mapped === 'Service' && typeof node.data['name'] === 'string') {
        graph.upsertEntity('Service', prune({
          name: node.data['name'],
          description: str(node.data['description']),
        }), src, { dedupeKey: slug(String(node.data['name'])) });
      } else if (mapped === 'Event' && typeof node.data['name'] === 'string') {
        graph.upsertEntity('Event', prune({
          name: node.data['name'],
          description: str(node.data['description']),
          startsAt: str(node.data['startDate']),
          endsAt: str(node.data['endDate']),
        }), src, { dedupeKey: slug(String(node.data['name'])) });
      }
    }
  }

  // --- Pass 2: heuristic extraction ------------------------------------
  if (!businessId) {
    const home = pages.find((p) => p.url === homeUrl) ?? pages[0];
    const name = home?.openGraph['og:site_name']
      ?? home?.title?.split(/[|\-–—]/).pop()?.trim()
      ?? 'Business';
    const created = graph.upsertEntity('Business', prune({
      name,
      description: home?.metaDescription ?? home?.openGraph['og:description'],
      websiteUrl: homeUrl,
    }), sourceFor(homeUrl, 'title/og'), { dedupeKey: 'primary' });
    if (created.ok) businessId = created.value.id;
  }

  const primaryLocation = ensurePrimaryLocation(graph, businessId, pages, homeUrl);

  for (const page of pages) {
    const src = sourceFor(page.url);

    for (const phone of page.phones) {
      graph.upsertEntity('ContactPoint', { contactType: 'phone', value: phone.value, label: phone.context },
        sourceFor(page.url, phone.context), { dedupeKey: `phone:${phone.value}`, confidenceByField: { value: phone.confidence } });
    }
    for (const email of page.emails) {
      graph.upsertEntity('ContactPoint', { contactType: 'email', value: email.value, label: email.context },
        sourceFor(page.url, email.context), { dedupeKey: `email:${email.value}`, confidenceByField: { value: email.confidence } });
    }
    for (const social of page.socialProfiles) {
      graph.upsertEntity('SocialProfile', prune({ network: social.network, url: social.url, handle: social.handle }),
        src, { dedupeKey: `${social.network}:${social.handle ?? social.url}` });
    }
    for (const faq of page.faqs) {
      graph.upsertEntity('FAQ', { question: faq.question, answer: faq.answer },
        sourceFor(page.url, 'faq'), { dedupeKey: slug(faq.question) });
    }
    for (const t of page.testimonials) {
      graph.upsertEntity('Testimonial', prune({ quote: t.quote, authorName: t.author, sourceUrl: page.url }),
        sourceFor(page.url, 'testimonial'), { dedupeKey: slug(t.quote.slice(0, 80)) });
    }
    for (const form of page.forms) {
      graph.upsertEntity('Form', prune({
        name: form.submitLabel ?? `Form on ${new URL(page.url).pathname}`,
        fields: form.fields,
        submitLabel: form.submitLabel,
        sourceUrl: page.url,
      }), sourceFor(page.url, 'form'), { dedupeKey: `${page.url}:${form.action ?? 'default'}` });
    }
    for (const doc of page.documents) {
      graph.upsertEntity('Document', prune({ title: doc.text || doc.href.split('/').pop(), fileUrl: doc.absolute ?? doc.href }),
        sourceFor(page.url, 'document link'), { dedupeKey: doc.absolute ?? doc.href });
    }
    for (const cta of page.ctas) {
      graph.upsertEntity('CTA', prune({ label: cta.label, href: cta.href, intent: ctaIntent(cta.label, cta.href) }),
        sourceFor(page.url, 'cta'), { dedupeKey: slug(cta.label) });
    }

    // Page-kind-driven entity harvesting.
    if (page.pageKind === 'service_detail') {
      const name = page.headings.find((h) => h.level === 1)?.text ?? page.title;
      if (name) {
        graph.upsertEntity('Service', prune({ name, description: firstParagraph(page.text) }),
          sourceFor(page.url, 'h1'), { dedupeKey: slug(name) });
      }
    }
    if (page.pageKind === 'article') {
      const title = page.headings.find((h) => h.level === 1)?.text ?? page.title;
      if (title) {
        graph.upsertEntity('Article', prune({
          title,
          slug: new URL(page.url).pathname.split('/').filter(Boolean).pop(),
          excerpt: page.metaDescription ?? firstParagraph(page.text),
          body: page.text,
        }), sourceFor(page.url, 'article'), { dedupeKey: slug(title) });
      }
    }
    if (page.pageKind === 'team') {
      for (const person of guessTeamMembers(page)) {
        graph.upsertEntity('Employee', prune(person), sourceFor(page.url, 'team page'), { dedupeKey: slug(person.name) });
      }
    }
    if (page.pageKind === 'contact' || page.pageKind === 'location') {
      for (const addr of page.addresses) {
        graph.upsertEntity('Location', {
          name: addr.value.city ? `${addr.value.city} office` : 'Main location',
          address: { street: addr.value.raw, city: addr.value.city, region: addr.value.region, postalCode: addr.value.postalCode },
        }, sourceFor(page.url, addr.context), {
          dedupeKey: slug(addr.value.raw),
          confidenceByField: { address: addr.confidence },
        });
      }
    }
  }

  // Relationships
  if (businessId) {
    if (primaryLocation) graph.relate(businessId, primaryLocation, 'locatedIn', 0.9);
    for (const service of graph.byType('Service')) graph.relate(businessId, service.id, 'offers', 0.85);
    for (const employee of graph.byType('Employee')) graph.relate(employee.id, businessId, 'worksAt', 0.85);
    for (const social of graph.byType('SocialProfile')) graph.relate(businessId, social.id, 'hasProfile', 0.9);
  }

  return graph;
}

function applyBusinessSideEffects(
  graph: KnowledgeGraph,
  businessId: string,
  fields: ReturnType<typeof readBusinessNode>,
  node: StructuredNode,
  src: SourceRef,
) {
  if (fields.telephone) {
    graph.upsertEntity('ContactPoint', { contactType: 'phone', value: fields.telephone, purpose: 'main' }, src,
      { dedupeKey: `phone:${fields.telephone}` });
  }
  if (fields.email) {
    graph.upsertEntity('ContactPoint', { contactType: 'email', value: fields.email, purpose: 'main' }, src,
      { dedupeKey: `email:${fields.email}` });
  }
  for (const url of fields.sameAs ?? []) {
    graph.upsertEntity('SocialProfile', { network: networkFromUrl(url), url }, src, { dedupeKey: url });
  }
  if (fields.address) {
    const addr = readPostalAddress(fields.address);
    const created = graph.upsertEntity('Location', prune({
      name: addr.city ? `${addr.city} location` : 'Main location',
      address: prune(addr),
      phone: fields.telephone,
      isPrimary: true,
    }), src, { dedupeKey: slug(Object.values(prune(addr)).join(' ')) });
    if (created.ok) graph.relate(businessId, created.value.id, 'locatedIn', 0.95);
  }
  void node;
}

function ensurePrimaryLocation(
  graph: KnowledgeGraph,
  businessId: string | undefined,
  pages: ExtractedPage[],
  homeUrl: string,
): string | undefined {
  const existing = graph.byType('Location').find((l) => l['isPrimary'] === true) ?? graph.byType('Location')[0];
  if (existing) return existing.id;

  const best = pages.flatMap((p) => p.addresses.map((a) => ({ page: p, addr: a })))
    .sort((a, b) => b.addr.confidence - a.addr.confidence)[0];
  if (!best) return undefined;

  const created = graph.upsertEntity('Location', {
    name: best.addr.value.city ? `${best.addr.value.city} location` : 'Main location',
    address: prune({
      street: best.addr.value.raw,
      city: best.addr.value.city,
      region: best.addr.value.region,
      postalCode: best.addr.value.postalCode,
    }),
    isPrimary: true,
  }, sourceFor(best.page.url, best.addr.context), {
    dedupeKey: slug(best.addr.value.raw),
    confidenceByField: { address: best.addr.confidence },
  });
  void businessId; void homeUrl;
  return created.ok ? created.value.id : undefined;
}

/**
 * Team pages are wildly inconsistent in markup. We use the conservative
 * signal — a heading that looks like a person's name with a role line beneath
 * it — and let everything land in the review queue rather than guessing hard.
 */
function guessTeamMembers(page: ExtractedPage): Array<{ name: string; role?: string }> {
  const out: Array<{ name: string; role?: string }> = [];
  const headings = page.headings.filter((h) => h.level >= 2 && h.level <= 4);
  for (const h of headings) {
    const text = h.text.trim();
    // Two to four capitalised words, no sentence punctuation.
    if (!/^[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){1,3}$/u.test(text)) continue;
    if (/\b(services?|about|contact|our team|welcome|home)\b/i.test(text)) continue;
    out.push({ name: text });
  }
  return out.slice(0, 60);
}

function ctaIntent(label: string, href?: string): string | undefined {
  if (href?.startsWith('tel:')) return 'call';
  if (href?.startsWith('mailto:')) return 'email';
  if (/quote|estimate/i.test(label)) return 'quote';
  if (/book|schedule|appointment/i.test(label)) return 'book';
  if (/buy|shop|cart|order/i.test(label)) return 'buy';
  if (/subscribe|newsletter|sign up/i.test(label)) return 'subscribe';
  if (/download/i.test(label)) return 'download';
  if (/direction|map/i.test(label)) return 'directions';
  return undefined;
}

function networkFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.')[0] ?? 'web';
  } catch {
    return 'web';
  }
}

function firstParagraph(text: string): string | undefined {
  const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 60);
  return para?.slice(0, 600);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function readOffer(node: StructuredNode): { amount: number; currency: string } | undefined {
  const offers = node.data['offers'];
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (!offer || typeof offer !== 'object') return undefined;
  const o = offer as Record<string, unknown>;
  const amount = Number(o['price']);
  if (!Number.isFinite(amount)) return undefined;
  return { amount, currency: typeof o['priceCurrency'] === 'string' ? o['priceCurrency'] : 'CAD' };
}

function slug(input: string): string {
  return input.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 80);
}

/** Drop undefined/empty values so partial extraction never writes blanks. */
function prune<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}
