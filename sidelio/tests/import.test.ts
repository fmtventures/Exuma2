import { describe, expect, it } from 'vitest';
import { asId, type OrgId, type SiteId, type UserId } from '../src/core/ids.ts';
import {
  covers, createAttestation, normalizeHost, suggestWebsiteFromEmail,
  type ImportAttestation,
} from '../src/import/authorization.ts';
import { isPubliclyRoutable, StaticFetcher } from '../src/import/fetcher.ts';
import { isAllowed, parseRobots } from '../src/import/robots.ts';
import { extractPage } from '../src/import/extract/html.ts';
import { classifySocialUrl, findPhones, normalizePhone, parseHoursLine } from '../src/import/extract/contacts.ts';
import { flattenJsonLd } from '../src/import/extract/schema-org.ts';
import { buildKnowledgeGraph, runCrawl } from '../src/import/pipeline.ts';
import { buildReview, summaryLines } from '../src/import/review.ts';
import { BROKEN_HTML, CONTACT_HTML, FIXTURE_PAGES, HOME_HTML, ROBOTS_TXT, TEAM_HTML } from './fixtures/site.ts';

const ORG = asId<OrgId>('org_1');
const SITE = asId<SiteId>('site_1');
const USER = asId<UserId>('usr_1');

function attestation(hosts = ['acmeroofing.ca']): ImportAttestation {
  const result = createAttestation({
    orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner', hosts, accepted: true,
  });
  if (!result.ok) throw new Error('attestation setup failed');
  return result.value;
}

describe('import authorization', () => {
  it('refuses to create an attestation that was not accepted', () => {
    const result = createAttestation({
      orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner',
      hosts: ['acmeroofing.ca'], accepted: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('IMPORT_NOT_AUTHORIZED');
  });

  it('requires a note for "other permission"', () => {
    const result = createAttestation({
      orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'other_permission',
      hosts: ['acmeroofing.ca'], accepted: true,
    });
    expect(result.ok).toBe(false);
  });

  it('normalizes hosts and strips www', () => {
    expect(normalizeHost('https://WWW.Acme.CA/contact?x=1')).toBe('acme.ca');
    expect(normalizeHost('acme.ca')).toBe('acme.ca');
    expect(normalizeHost('not a url at all !!')).toBeNull();
  });

  it('covers subdomains but not unrelated hosts', () => {
    const att = attestation();
    expect(covers(att, 'https://acmeroofing.ca/services')).toBe(true);
    expect(covers(att, 'https://blog.acmeroofing.ca/post')).toBe(true);
    expect(covers(att, 'https://competitor.ca/')).toBe(false);
    expect(covers(att, 'https://notacmeroofing.ca/')).toBe(false);
  });

  it('suggests a site from a business email but never from free mail', () => {
    expect(suggestWebsiteFromEmail('info@acmeroofing.ca')?.host).toBe('acmeroofing.ca');
    expect(suggestWebsiteFromEmail('someone@gmail.com')).toBeNull();
  });
});

describe('fetch safety', () => {
  it('blocks private and metadata addresses', () => {
    for (const url of [
      'http://localhost:3000', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.4.4/', 'file:///etc/passwd',
    ]) {
      expect(isPubliclyRoutable(url), url).toBe(false);
    }
  });

  it('allows ordinary public URLs', () => {
    expect(isPubliclyRoutable('https://acmeroofing.ca/')).toBe(true);
  });
});

describe('robots.txt', () => {
  const policy = parseRobots(ROBOTS_TXT);

  it('reads rules, delay and sitemaps', () => {
    expect(policy.sitemaps).toEqual(['https://acmeroofing.ca/sitemap.xml']);
    expect(policy.crawlDelaySeconds).toBe(0);
  });

  it('applies longest-match precedence', () => {
    expect(isAllowed(policy, '/private')).toBe(false);
    expect(isAllowed(policy, '/private/deep')).toBe(false);
    expect(isAllowed(policy, '/services')).toBe(true);
  });

  it('prefers a bot-specific group over the wildcard', () => {
    const specific = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: SidelioImportBot\nAllow: /\nDisallow: /admin\n',
    );
    expect(isAllowed(specific, '/anything')).toBe(true);
    expect(isAllowed(specific, '/admin')).toBe(false);
  });

  it('treats an empty robots.txt as permissive', () => {
    expect(isAllowed(parseRobots(''), '/anything')).toBe(true);
  });
});

describe('contact extraction', () => {
  it('normalizes phone formats to one value', () => {
    expect(normalizePhone('(902) 555-1234')).toBe('902-555-1234');
    expect(normalizePhone('+1 902.555.1234')).toBe('902-555-1234');
    expect(normalizePhone('902-555-1234 ext 12')).toBe('902-555-1234 ext. 12');
  });

  it('ignores number-like strings that are not phones', () => {
    expect(findPhones('Serving PEI since 1998 to 2026', 'body')).toHaveLength(0);
    expect(findPhones('0000000000', 'body')).toHaveLength(0);
  });

  it('parses day ranges, lists and closures', () => {
    expect(parseHoursLine('Monday - Friday: 7:00am - 5:00pm')).toHaveLength(5);
    expect(parseHoursLine('Sunday: Closed')).toEqual([{ dayOfWeek: 'sun', closed: true }]);
    const sat = parseHoursLine('Saturday: 8:00am - 12:00pm')[0];
    expect(sat?.opens).toBe('08:00');
    expect(sat?.closes).toBe('12:00');
  });

  it('infers a missing opening meridiem sensibly', () => {
    expect(parseHoursLine('Monday: 9 - 5pm')[0]).toMatchObject({ opens: '09:00', closes: '17:00' });
  });

  it('classifies social profiles and skips share buttons', () => {
    expect(classifySocialUrl('https://www.facebook.com/acmeroofingpei')).toEqual({ network: 'facebook', handle: 'acmeroofingpei' });
    expect(classifySocialUrl('https://www.facebook.com/sharer/sharer.php?u=x')).toBeNull();
    expect(classifySocialUrl('https://acmeroofing.ca/')).toBeNull();
  });
});

describe('JSON-LD', () => {
  it('flattens nested graphs', () => {
    const nodes = flattenJsonLd({
      '@graph': [
        { '@type': 'Organization', name: 'Acme', address: { '@type': 'PostalAddress', addressLocality: 'Charlottetown' } },
        { '@type': ['Person', 'Employee'], name: 'Melissa' },
      ],
    });
    expect(nodes.map((n) => n.type).sort()).toEqual(['Employee', 'Organization', 'Person', 'PostalAddress']);
  });

  it('survives malformed JSON without throwing', () => {
    expect(() => flattenJsonLd(undefined)).not.toThrow();
  });
});

describe('page extraction', () => {
  const home = extractPage(HOME_HTML, 'https://acmeroofing.ca/');

  it('reads title, description and canonical', () => {
    expect(home.title).toContain('Acme Roofing');
    expect(home.metaDescription).toContain('1998');
    expect(home.canonical).toBe('https://acmeroofing.ca/');
  });

  it('builds nested navigation', () => {
    expect(home.navigation.map((i) => i.label)).toEqual(['Home', 'Services', 'About', 'Contact']);
    expect(home.navigation[1]?.children.map((c) => c.label)).toEqual(['Roof Replacement', 'Roof Repair']);
  });

  it('classifies the page kind', () => {
    expect(home.pageKind).toBe('home');
    expect(extractPage(CONTACT_HTML, 'https://acmeroofing.ca/contact').pageKind).toBe('contact');
    expect(extractPage(TEAM_HTML, 'https://acmeroofing.ca/team').pageKind).toBe('team');
  });

  it('ranks a tel: link above a number found in prose', () => {
    const best = home.phones.sort((a, b) => b.confidence - a.confidence)[0];
    expect(best?.value).toBe('902-555-1234');
    expect(best?.confidence).toBeGreaterThan(0.9);
  });

  it('finds the address and full opening hours', () => {
    expect(home.addresses[0]?.value.postalCode?.replace(/\s/g, '')).toBe('C1A1A9');
    expect(home.openingHours[0]?.value).toHaveLength(7);
  });

  it('extracts testimonials with their attribution', () => {
    expect(home.testimonials).toHaveLength(2);
    expect(home.testimonials[0]?.author).toBe('Dana MacLeod');
    expect(home.testimonials[0]?.quote).not.toContain('Dana MacLeod');
  });

  it('extracts FAQs from heading/answer pairs', () => {
    expect(home.faqs.map((f) => f.question)).toContain('How long does a roof replacement take?');
  });

  it('detects analytics and pixels', () => {
    const vendors = home.tracking.map((t) => t.vendor);
    expect(vendors).toContain('ga4');
    expect(vendors).toContain('meta_pixel');
    expect(home.tracking.find((t) => t.vendor === 'ga4')?.id).toBe('G-ABC1234567');
  });

  it('separates documents from ordinary links', () => {
    expect(home.documents.map((d) => d.href)).toContain('/warranty.pdf');
  });

  it('finds CTAs including tel: links', () => {
    expect(home.ctas.some((c) => c.href?.startsWith('tel:'))).toBe(true);
  });

  it('audits real technical problems', () => {
    const broken = extractPage(BROKEN_HTML, 'https://acmeroofing.ca/private');
    const codes = broken.audit.map((f) => f.code);
    expect(codes).toContain('missing_title');
    expect(codes).toContain('missing_h1');
    expect(codes).toContain('images_missing_alt');
    expect(codes).toContain('thin_content');
  });

  it('excludes navigation chrome from body text', () => {
    expect(home.text).not.toContain('Roof Replacement\nRoof Repair\nAbout\nContact');
    expect(home.wordCount).toBeGreaterThan(80);
  });
});

describe('crawl pipeline', () => {
  const deps = { fetcher: new StaticFetcher(FIXTURE_PAGES), sleep: async () => {} };

  it('refuses seeds outside the attestation before touching the network', async () => {
    const job = await runCrawl({
      siteId: SITE, attestation: attestation(['acmeroofing.ca']), seeds: ['https://competitor.ca/'],
    }, deps);
    expect(job.status).toBe('failed');
    expect(job.outcomes[0]?.status).toBe('error');
  });

  it('crawls the site, honours robots.txt, and reports what it skipped', async () => {
    const job = await runCrawl({
      siteId: SITE, attestation: attestation(), seeds: ['https://acmeroofing.ca/'],
      budget: { maxPages: 20, maxDepth: 2 },
    }, deps);

    expect(job.status).toBe('ready_for_review');
    const extracted = job.outcomes.filter((o) => o.status === 'extracted');
    expect(extracted.length).toBeGreaterThanOrEqual(4);
    expect(job.outcomes.some((o) => o.status === 'skipped_robots' && o.url.includes('/private'))).toBe(true);
    // PDFs are recorded as documents, not crawled as pages.
    expect(job.outcomes.some((o) => o.url.endsWith('.pdf'))).toBe(false);
  });

  it('crawls each URL once when the seed also appears in the sitemap', async () => {
    const job = await runCrawl({
      siteId: SITE, attestation: attestation(), seeds: ['https://acmeroofing.ca/'],
      budget: { maxPages: 30, maxDepth: 3 },
    }, deps);

    const urls = job.outcomes.filter((o) => o.status === 'extracted').map((o) => o.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.filter((u) => u === 'https://acmeroofing.ca/')).toHaveLength(1);
  });

  it('stops at the page budget', async () => {
    const job = await runCrawl({
      siteId: SITE, attestation: attestation(), seeds: ['https://acmeroofing.ca/'],
      budget: { maxPages: 2 },
    }, deps);
    expect(job.outcomes.filter((o) => o.status === 'extracted')).toHaveLength(2);
    expect(job.outcomes.some((o) => o.status === 'skipped_budget')).toBe(true);
  });
});

describe('knowledge graph construction', () => {
  const deps = { fetcher: new StaticFetcher(FIXTURE_PAGES), sleep: async () => {} };

  async function build() {
    const job = await runCrawl({
      siteId: SITE, attestation: attestation(), seeds: ['https://acmeroofing.ca/'],
      budget: { maxPages: 20, maxDepth: 2 },
    }, deps);
    return { job, graph: buildKnowledgeGraph(SITE, job) };
  }

  it('prefers structured data for the business record', async () => {
    const { graph } = await build();
    const business = graph.byType('Business')[0];
    expect(business?.['name']).toBe('Acme Roofing Ltd.');
    // From JSON-LD, so it should auto-approve and be publishable.
    expect(graph.publishableEntity(business?.id ?? '')?.['name']).toBe('Acme Roofing Ltd.');
  });

  it('captures contacts, socials, testimonials and FAQs', async () => {
    const { graph } = await build();
    const stats = graph.stats();
    expect(stats.entitiesByType.ContactPoint ?? 0).toBeGreaterThanOrEqual(2);
    expect(stats.entitiesByType.SocialProfile ?? 0).toBeGreaterThanOrEqual(2);
    expect(stats.entitiesByType.Testimonial ?? 0).toBe(2);
    expect(stats.entitiesByType.FAQ ?? 0).toBeGreaterThanOrEqual(2);
    expect(stats.entitiesByType.Location ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('reads team members without mistaking section headings for people', async () => {
    const { graph } = await build();
    const names = graph.byType('Employee').map((e) => e['name']);
    expect(names).toContain('Melissa Doyle');
    expect(names).toContain('Robert Arsenault');
    expect(names).not.toContain('Our Services');
  });

  it('deduplicates the same phone number seen on several pages', async () => {
    const { graph } = await build();
    const phones = graph.byType('ContactPoint').filter((c) => c['contactType'] === 'phone');
    expect(new Set(phones.map((p) => p['value'])).size).toBe(phones.length);
  });

  it('links the business to its services and profiles', async () => {
    const { graph } = await build();
    const business = graph.byType('Business')[0];
    if (!business) throw new Error('no business');
    expect(graph.related(business.id, 'hasProfile').length).toBeGreaterThanOrEqual(2);
  });
});

describe('import review', () => {
  const deps = { fetcher: new StaticFetcher(FIXTURE_PAGES), sleep: async () => {} };

  it('summarizes findings and recommends per-page decisions', async () => {
    const job = await runCrawl({
      siteId: SITE, attestation: attestation(), seeds: ['https://acmeroofing.ca/'],
      budget: { maxPages: 20, maxDepth: 2 },
    }, deps);
    const graph = buildKnowledgeGraph(SITE, job);
    const review = buildReview(job, graph);

    expect(review.summary.pages).toBeGreaterThanOrEqual(4);
    expect(summaryLines(review.summary).some((l) => l.includes('page'))).toBe(true);

    const home = review.pages.find((p) => p.url === 'https://acmeroofing.ca/');
    expect(home?.recommended).toBe('improve'); // hero image has no alt text

    const thin = review.pages.find((p) => p.url.includes('/services') && p.wordCount < 60);
    expect(thin?.recommended).toBe('ignore');
  });

  it('warns about redirects, robots skips and tracking before publish', async () => {
    const job = await runCrawl({
      siteId: SITE, attestation: attestation(), seeds: ['https://acmeroofing.ca/'],
      budget: { maxPages: 20, maxDepth: 2 },
    }, deps);
    const review = buildReview(job, buildKnowledgeGraph(SITE, job));
    const codes = review.warnings.map((w) => w.code);
    expect(codes).toContain('redirects_required');
    expect(codes).toContain('robots_blocked');
    expect(codes).toContain('tracking_needs_reconnection');
  });

  it('deduplicates assets used on multiple pages', async () => {
    const job = await runCrawl({
      siteId: SITE, attestation: attestation(), seeds: ['https://acmeroofing.ca/'],
      budget: { maxPages: 20, maxDepth: 2 },
    }, deps);
    const review = buildReview(job, buildKnowledgeGraph(SITE, job));
    const small = review.assets.find((a) => a.url.includes('small.jpg'));
    expect(small?.usedOnPages.length).toBeGreaterThan(1);
    expect(small?.recommended).toBe('replace_ai'); // 320px is too small
  });
});
