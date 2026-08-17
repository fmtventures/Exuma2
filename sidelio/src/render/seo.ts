import type { Page } from '../blocks/page.ts';
import type { Block } from '../blocks/schema.ts';
import type { Entity } from '../knowledge/entities.ts';
import type { KnowledgeGraph } from '../knowledge/graph.ts';
import { escapeAttr, escapeHtml } from './html.ts';

/**
 * SEO and AEO output.
 *
 * "AEO" — answer engine optimization — is mostly the same discipline as SEO
 * done properly: unambiguous structured data, clean heading hierarchy, direct
 * answers to real questions, and machine-readable business facts. So this
 * module derives everything from the knowledge graph rather than asking the
 * user to hand-maintain a parallel set of meta tags.
 *
 * Only publishable facts reach the output — the same gate the renderer uses.
 */

export interface SeoInput {
  page: Page;
  origin: string;
  graph?: KnowledgeGraph;
  siteName?: string;
  defaultOgImageUrl?: string;
  locale?: string;
  alternateLocales?: Array<{ locale: string; url: string }>;
}

export function canonicalUrl(origin: string, path: string): string {
  const base = origin.replace(/\/$/, '');
  return path === '/' ? `${base}/` : `${base}${path}`;
}

export function renderHead(input: SeoInput): string {
  const { page, origin } = input;
  const title = page.seo.metaTitle ?? page.title;
  const description = page.seo.metaDescription;
  const canonical = page.seo.canonical ?? canonicalUrl(origin, page.path);
  const ogImage = input.defaultOgImageUrl;

  const tags: string[] = [
    `<title>${escapeHtml(title)}</title>`,
    description ? `<meta name="description" content="${escapeAttr(description)}">` : '',
    `<link rel="canonical" href="${escapeAttr(canonical)}">`,
    page.seo.noindex ? '<meta name="robots" content="noindex,nofollow">' : '<meta name="robots" content="index,follow,max-image-preview:large">',

    `<meta property="og:type" content="${page.path === '/' ? 'website' : 'article'}">`,
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    description ? `<meta property="og:description" content="${escapeAttr(description)}">` : '',
    `<meta property="og:url" content="${escapeAttr(canonical)}">`,
    input.siteName ? `<meta property="og:site_name" content="${escapeAttr(input.siteName)}">` : '',
    ogImage ? `<meta property="og:image" content="${escapeAttr(ogImage)}">` : '',
    `<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeAttr(title)}">`,
    description ? `<meta name="twitter:description" content="${escapeAttr(description)}">` : '',
  ];

  for (const alt of input.alternateLocales ?? []) {
    tags.push(`<link rel="alternate" hreflang="${escapeAttr(alt.locale)}" href="${escapeAttr(alt.url)}">`);
  }

  const jsonLd = buildStructuredData(input);
  for (const node of jsonLd) {
    tags.push(`<script type="application/ld+json">${jsonLdSafe(node)}</script>`);
  }

  return tags.filter(Boolean).join('\n');
}

/**
 * `</script>` inside JSON-LD would close the tag early — the classic XSS in
 * structured data. Escaping the forward slash is the standard fix and remains
 * valid JSON.
 */
function jsonLdSafe(node: unknown): string {
  return JSON.stringify(node).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

export function buildStructuredData(input: SeoInput): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const { page, origin, graph } = input;

  if (graph) {
    const business = publishable(graph, 'Business');
    if (business) {
      const contacts = publishableAll(graph, 'ContactPoint');
      const location = publishableAll(graph, 'Location')[0];
      const socials = publishableAll(graph, 'SocialProfile');

      const node: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'LocalBusiness',
        name: business['name'],
        url: origin,
      };
      if (business['description']) node['description'] = business['description'];

      const phone = contacts.find((c) => c['contactType'] === 'phone');
      if (phone) node['telephone'] = phone['value'];
      const email = contacts.find((c) => c['contactType'] === 'email');
      if (email) node['email'] = email['value'];

      if (location?.['address']) {
        const a = location['address'] as Record<string, unknown>;
        node['address'] = clean({
          '@type': 'PostalAddress',
          streetAddress: a['street'],
          addressLocality: a['city'],
          addressRegion: a['region'],
          postalCode: a['postalCode'],
          addressCountry: a['country'],
        });
        if (typeof a['latitude'] === 'number' && typeof a['longitude'] === 'number') {
          node['geo'] = { '@type': 'GeoCoordinates', latitude: a['latitude'], longitude: a['longitude'] };
        }
      }

      const hours = location?.['hours'];
      if (Array.isArray(hours) && hours.length > 0) {
        node['openingHoursSpecification'] = hours
          .filter((h: Record<string, unknown>) => !h['closed'] && h['opens'] && h['closes'])
          .map((h: Record<string, unknown>) => ({
            '@type': 'OpeningHoursSpecification',
            dayOfWeek: `https://schema.org/${DAY_NAMES[String(h['dayOfWeek'])] ?? 'Monday'}`,
            opens: h['opens'],
            closes: h['closes'],
          }));
      }

      if (socials.length > 0) node['sameAs'] = socials.map((s) => s['url']).filter(Boolean);
      nodes.push(node);
    }
  }

  // Breadcrumbs help both search results and answer engines place the page.
  if (page.path !== '/') {
    const segments = page.path.split('/').filter(Boolean);
    const items = [{ '@type': 'ListItem', position: 1, name: 'Home', item: canonicalUrl(origin, '/') }];
    let acc = '';
    segments.forEach((segment, i) => {
      acc += `/${segment}`;
      items.push({
        '@type': 'ListItem',
        position: i + 2,
        name: i === segments.length - 1 ? page.title : titleize(segment),
        item: canonicalUrl(origin, acc),
      });
    });
    nodes.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items });
  }

  // FAQ blocks emit FAQPage — the highest-leverage AEO markup there is.
  const faqBlocks = page.blocks.filter((b) => b.type === 'faq' && b.props['emitSchema'] !== false);
  const questions = faqBlocks.flatMap((b) =>
    (Array.isArray(b.props['items']) ? b.props['items'] : []) as Array<{ question: string; answer: string }>);
  if (questions.length > 0) {
    nodes.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: questions.map((q) => ({
        '@type': 'Question',
        name: q.question,
        acceptedAnswer: { '@type': 'Answer', text: stripTags(q.answer) },
      })),
    });
  }

  for (const extra of page.seo.structuredData ?? []) nodes.push(extra);
  return nodes;
}

const DAY_NAMES: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

function publishable(graph: KnowledgeGraph, type: Parameters<KnowledgeGraph['byType']>[0]): Entity | undefined {
  const first = graph.byType(type)[0];
  return first ? graph.publishableEntity(first.id) : undefined;
}

function publishableAll(graph: KnowledgeGraph, type: Parameters<KnowledgeGraph['byType']>[0]): Entity[] {
  return graph.byType(type)
    .map((e) => graph.publishableEntity(e.id))
    .filter((e): e is Entity => e !== undefined);
}

function clean(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function titleize(segment: string): string {
  return segment.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ */
/* Site-level SEO artifacts                                            */
/* ------------------------------------------------------------------ */

export function renderSitemap(origin: string, pages: Page[]): string {
  const entries = pages.map((p) => {
    const loc = canonicalUrl(origin, p.path);
    const priority = p.path === '/' ? '1.0' : p.path.split('/').length <= 2 ? '0.8' : '0.6';
    return `  <url>\n    <loc>${escapeHtml(loc)}</loc>\n    <lastmod>${p.updatedAt.slice(0, 10)}</lastmod>\n    <priority>${priority}</priority>\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>`;
}

export function renderRobotsTxt(origin: string, opts: { allowIndexing: boolean } = { allowIndexing: true }): string {
  if (!opts.allowIndexing) {
    return 'User-agent: *\nDisallow: /\n';
  }
  return `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${origin.replace(/\/$/, '')}/sitemap.xml\n`;
}

/* ------------------------------------------------------------------ */
/* On-page SEO audit                                                   */
/* ------------------------------------------------------------------ */

export interface SeoIssue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  fix: string;
}

/** Runs on every save so problems surface before publish, not after. */
export function auditPageSeo(page: Page): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const title = page.seo.metaTitle ?? page.title;

  if (!title) {
    issues.push({ code: 'missing_title', severity: 'error', message: 'This page has no title.', fix: 'Add a page title.' });
  } else if (title.length > 60) {
    issues.push({ code: 'title_too_long', severity: 'warning', message: `Title is ${title.length} characters; search results cut off around 60.`, fix: 'Shorten the title.' });
  } else if (title.length < 15) {
    issues.push({ code: 'title_too_short', severity: 'info', message: 'Title is very short.', fix: 'Add the business name or a descriptive phrase.' });
  }

  const desc = page.seo.metaDescription;
  if (!desc) {
    issues.push({ code: 'missing_description', severity: 'warning', message: 'No meta description.', fix: 'Write a 120–160 character summary, or let the assistant draft one.' });
  } else if (desc.length > 160) {
    issues.push({ code: 'description_too_long', severity: 'info', message: `Description is ${desc.length} characters.`, fix: 'Trim to 160 characters or fewer.' });
  }

  const h1Count = page.blocks.filter((b) => b.type === 'hero').length;
  if (h1Count === 0) {
    issues.push({ code: 'missing_h1', severity: 'warning', message: 'No H1 heading on the page.', fix: 'Add a hero section, which renders the H1.' });
  } else if (h1Count > 1) {
    issues.push({ code: 'multiple_h1', severity: 'warning', message: `${h1Count} hero sections produce ${h1Count} H1 headings.`, fix: 'Keep one hero per page.' });
  }

  const missingAlt = countMissingAlt(page.blocks);
  if (missingAlt > 0) {
    issues.push({ code: 'images_missing_alt', severity: 'error', message: `${missingAlt} image(s) have no alt text.`, fix: 'Add descriptions, or generate them in AI Media Studio.' });
  }

  const words = estimateWordCount(page.blocks);
  if (words < 150 && !page.seo.noindex) {
    issues.push({ code: 'thin_content', severity: 'warning', message: `Roughly ${words} words of content.`, fix: 'Add more substance, or mark the page noindex if it is intentionally thin.' });
  }

  return issues;
}

function countMissingAlt(blocks: Block[]): number {
  let count = 0;
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    // An image reference is anything carrying an assetId or url.
    if (('assetId' in obj || 'url' in obj) && !('quote' in obj)) {
      const alt = obj['alt'];
      if (typeof alt !== 'string' || alt.trim() === '') count += 1;
    }
    Object.values(obj).forEach(walk);
  };
  blocks.forEach((b) => walk(b.props));
  return count;
}

function estimateWordCount(blocks: Block[]): number {
  let words = 0;
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      words += value.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
      return;
    }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  blocks.forEach((b) => walk(b.props));
  return words;
}
