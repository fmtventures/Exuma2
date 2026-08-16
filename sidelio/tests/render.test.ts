import { describe, expect, it } from 'vitest';
import type { Page } from '../src/blocks/page.ts';
import type { Block } from '../src/blocks/schema.ts';
import { isVisibleAt, resolveResponsive, validateBlock } from '../src/blocks/schema.ts';
import { asId, type SiteId } from '../src/core/ids.ts';
import { auditContrast, contrastRatio, DEFAULT_BRAND_KIT, generateScale, readableTextOn, toCssVariables } from '../src/design/brand-kit.ts';
import { escapeHtml, renderBlock, renderBlocks, safeUrl, sanitizeHtml, type RenderContext } from '../src/render/html.ts';
import { auditPageSeo, buildStructuredData, renderHead, renderRobotsTxt, renderSitemap } from '../src/render/seo.ts';
import { KnowledgeGraph } from '../src/knowledge/graph.ts';

const SITE = asId<SiteId>('site_1');
const source = { kind: 'user_input' as const, locator: 'admin', retrievedAt: '2026-08-01T00:00:00Z' };

function block(type: string, props: Record<string, unknown>, over: Partial<Block> = {}): Block {
  return {
    id: `b_${type}`, type: type as Block['type'], props,
    style: { scheme: 'inherit', animation: 'none' },
    visibility: { hiddenOn: [], requiresAuth: false },
    locked: false, ...over,
  };
}

function page(blocks: Block[], over: Partial<Page> = {}): Page {
  return {
    id: 'page_home', siteId: SITE, path: '/', title: 'Home', blocks,
    seo: { noindex: false, metaTitle: 'Acme Roofing | Charlottetown', metaDescription: 'Roofing across PEI since 1998.' },
    status: 'published', order: 0, locale: 'en', updatedAt: '2026-08-01T00:00:00Z', ...over,
  };
}

function ctx(p: Page): RenderContext {
  return { page: p, brandKit: DEFAULT_BRAND_KIT, assets: new Map(), origin: 'https://acmeroofing.ca' };
}

describe('escaping and sanitization', () => {
  it('escapes HTML in text content', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('rejects javascript: and data: URLs', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('data:text/html,<script>')).toBe('');
    expect(safeUrl('  JaVaScRiPt:alert(1)')).toBe('');
    expect(safeUrl('https://acmeroofing.ca')).toBe('https://acmeroofing.ca');
    expect(safeUrl('tel:9025551234')).toBe('tel:9025551234');
    expect(safeUrl('/contact')).toBe('/contact');
  });

  it('strips scripts, styles and event handlers from rich text', () => {
    const dirty = '<p onclick="steal()">Hi</p><script>evil()</script><style>body{}</style><iframe src="x"></iframe>';
    const clean = sanitizeHtml(dirty);
    expect(clean).toContain('<p>Hi</p>');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('script');
    expect(clean).not.toContain('iframe');
  });

  it('keeps allowed links but drops unsafe hrefs', () => {
    expect(sanitizeHtml('<a href="https://x.ca">ok</a>')).toContain('href="https://x.ca"');
    expect(sanitizeHtml('<a href="javascript:x()">bad</a>')).toBe('<a>bad</a>');
  });

  it('adds noopener to target=_blank links', () => {
    expect(sanitizeHtml('<a href="https://x.ca" target="_blank">ok</a>')).toContain('rel="noopener noreferrer"');
  });
});

describe('block rendering', () => {
  it('renders a hero with one H1 and an eager, high-priority image', () => {
    const html = renderBlock(block('hero', {
      heading: 'Roofing you can rely on',
      subheading: 'Serving PEI since 1998',
      image: { url: '/hero.jpg', alt: 'A finished roof' },
      overlay: 'gradient', layout: 'split', height: 'large', buttons: [],
    }), ctx(page([])));

    expect(html).toContain('<h1 class="sl-hero__heading">Roofing you can rely on</h1>');
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(html).toContain('loading="eager"');
    expect(html).toContain('alt="A finished roof"');
  });

  it('always emits an alt attribute, even when empty', () => {
    const html = renderBlock(block('gallery', { images: [{ url: '/a.jpg' }], layout: 'grid', columns: 3 }), ctx(page([])));
    expect(html).toContain('alt=""');
  });

  it('escapes user content in headings and buttons', () => {
    const html = renderBlock(block('cta', {
      heading: '<img src=x onerror=alert(1)>',
      buttons: [{ label: '"><script>', href: 'javascript:x()', style: 'primary', newTab: false }],
    }), ctx(page([])));
    // The payload survives as inert text; what matters is that no tag or
    // attribute is ever formed from it, and the unsafe href is dropped.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script');
  });

  it('renders FAQs as native accessible disclosure elements', () => {
    const html = renderBlock(block('faq', {
      items: [{ question: 'How long does it take?', answer: '<p>One to three days.</p>' }],
      layout: 'accordion', emitSchema: true,
    }), ctx(page([])));
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
  });

  it('lazy-loads non-hero images', () => {
    const html = renderBlock(block('text_image', {
      body: 'About us', image: { url: '/a.jpg', alt: 'Crew' }, imagePosition: 'right', buttons: [],
    }), ctx(page([])));
    expect(html).toContain('loading="lazy"');
  });

  it('omits collection blocks with nothing to show', () => {
    expect(renderBlock(block('services', { items: [] }), ctx(page([])))).toBe('');
    expect(renderBlock(block('testimonials', { items: [] }), ctx(page([])))).toBe('');
  });

  it('marks urgent banners with role=alert', () => {
    const html = renderBlock(block('banner', { message: 'Closed Monday', tone: 'urgent', dismissible: true }), ctx(page([])));
    expect(html).toContain('role="alert"');
  });

  it('skips blocks hidden at the current breakpoint', () => {
    const p = page([
      block('hero', { heading: 'Visible' }),
      block('cta', { heading: 'Hidden on mobile', buttons: [] }, { visibility: { hiddenOn: ['mobile'], requiresAuth: false } }),
    ]);
    const html = renderBlocks({ ...ctx(p), breakpoint: 'mobile' });
    expect(html).toContain('Visible');
    expect(html).not.toContain('Hidden on mobile');
  });

  it('respects scheduled visibility windows', () => {
    const scheduled = block('banner', { message: 'Fall sale' }, {
      visibility: { hiddenOn: [], requiresAuth: false, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-09-30T00:00:00Z' },
    });
    expect(isVisibleAt(scheduled, 'desktop', new Date('2026-08-15T00:00:00Z'))).toBe(false);
    expect(isVisibleAt(scheduled, 'desktop', new Date('2026-09-15T00:00:00Z'))).toBe(true);
    expect(isVisibleAt(scheduled, 'desktop', new Date('2026-10-15T00:00:00Z'))).toBe(false);
  });
});

describe('block validation', () => {
  it('accepts a well-formed block', () => {
    expect(validateBlock(block('hero', { heading: 'Hello' }))).toHaveLength(0);
  });

  it('reports the offending field', () => {
    const issues = validateBlock(block('hero', {}));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toBe('heading');
  });

  it('rejects a CTA with no buttons', () => {
    expect(validateBlock(block('cta', { heading: 'Go', buttons: [] })).length).toBeGreaterThan(0);
  });
});

describe('responsive values', () => {
  it('falls back down the breakpoint ladder', () => {
    const value = { desktop: '64px', mobile: '24px' };
    expect(resolveResponsive(value, 'wide')).toBe('64px');
    expect(resolveResponsive(value, 'desktop')).toBe('64px');
    expect(resolveResponsive(value, 'tablet')).toBe('24px');
    expect(resolveResponsive(value, 'mobile')).toBe('24px');
  });

  it('passes scalars through', () => {
    expect(resolveResponsive('48px', 'mobile')).toBe('48px');
  });
});

describe('brand kit', () => {
  it('picks readable text for a background', () => {
    expect(readableTextOn('#0f172a')).toBe('#ffffff');
    expect(readableTextOn('#ffffff')).toBe('#0f172a');
  });

  it('computes known contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 1);
  });

  it('finds no issues in the default kit', () => {
    expect(auditContrast(DEFAULT_BRAND_KIT)).toHaveLength(0);
  });

  it('flags an invisible button even when its label is legible', () => {
    const kit = { ...DEFAULT_BRAND_KIT, colors: { ...DEFAULT_BRAND_KIT.colors, primary: '#f2f2f2' } };
    const issues = auditContrast(kit);
    expect(issues.some((i) => i.kind === 'ui')).toBe(true);
  });

  it('flags illegible body text', () => {
    const kit = { ...DEFAULT_BRAND_KIT, colors: { ...DEFAULT_BRAND_KIT.colors, text: '#eeeeee' } };
    expect(auditContrast(kit).some((i) => i.kind === 'text' && i.token.includes('text on background'))).toBe(true);
  });

  it('generates an ordered colour ramp', () => {
    const scale = generateScale('#2563eb');
    expect(Object.keys(scale)).toHaveLength(10);
    expect(scale['50']).not.toBe(scale['900']);
  });

  it('emits CSS variables for colours, type and spacing', () => {
    const css = toCssVariables(DEFAULT_BRAND_KIT);
    expect(css).toContain('--sl-color-primary:');
    expect(css).toContain('--sl-color-on-primary:');
    expect(css).toContain('--sl-text-h1:');
    expect(css).toContain('--sl-space-1:');
  });
});

describe('SEO output', () => {
  const graph = new KnowledgeGraph(SITE);
  const business = graph.upsertEntity('Business', { name: 'Acme Roofing Ltd.', description: 'Roofers on PEI.' }, source);
  graph.upsertEntity('ContactPoint', { contactType: 'phone', value: '902-555-1234' }, source);
  graph.upsertEntity('Location', {
    name: 'Charlottetown', isPrimary: true,
    address: { street: '42 Water Street', city: 'Charlottetown', region: 'PE', postalCode: 'C1A 1A9', country: 'CA' },
    hours: [{ dayOfWeek: 'mon', opens: '07:00', closes: '17:00', closed: false }],
  }, source);
  void business;

  it('emits canonical, robots and Open Graph tags', () => {
    const head = renderHead({ page: page([]), origin: 'https://acmeroofing.ca', siteName: 'Acme Roofing' });
    expect(head).toContain('<link rel="canonical" href="https://acmeroofing.ca/">');
    expect(head).toContain('content="index,follow,max-image-preview:large"');
    expect(head).toContain('property="og:title"');
  });

  it('emits noindex when the page is marked private', () => {
    const p = page([], { seo: { noindex: true } });
    expect(renderHead({ page: p, origin: 'https://acmeroofing.ca' })).toContain('noindex,nofollow');
  });

  it('builds LocalBusiness structured data from the knowledge graph', () => {
    const nodes = buildStructuredData({ page: page([]), origin: 'https://acmeroofing.ca', graph });
    const biz = nodes.find((n) => n['@type'] === 'LocalBusiness');
    expect(biz?.['name']).toBe('Acme Roofing Ltd.');
    expect(biz?.['telephone']).toBe('902-555-1234');
    expect((biz?.['address'] as Record<string, unknown>)['addressLocality']).toBe('Charlottetown');
    expect(Array.isArray(biz?.['openingHoursSpecification'])).toBe(true);
  });

  it('emits FAQPage markup from FAQ blocks', () => {
    const p = page([block('faq', { items: [{ question: 'How long?', answer: '<p>Two days.</p>' }], emitSchema: true })]);
    const faq = buildStructuredData({ page: p, origin: 'https://acmeroofing.ca' }).find((n) => n['@type'] === 'FAQPage');
    const entity = (faq?.['mainEntity'] as Array<Record<string, unknown>>)[0];
    expect(entity?.['name']).toBe('How long?');
    expect((entity?.['acceptedAnswer'] as Record<string, unknown>)['text']).toBe('Two days.');
  });

  it('escapes angle brackets so JSON-LD cannot break out of its script tag', () => {
    const p = page([], { title: '</script><script>alert(1)</script>', seo: { noindex: false } });
    const head = renderHead({ page: p, origin: 'https://acmeroofing.ca' });
    const ldBlocks = head.split('<script type="application/ld+json">').slice(1);
    for (const b of ldBlocks) {
      expect(b.slice(0, b.indexOf('</script>'))).not.toContain('<');
    }
  });

  it('builds breadcrumbs for nested pages', () => {
    const p = page([], { path: '/services/roof-repair', title: 'Roof Repair' });
    const crumbs = buildStructuredData({ page: p, origin: 'https://acmeroofing.ca' })
      .find((n) => n['@type'] === 'BreadcrumbList');
    expect((crumbs?.['itemListElement'] as unknown[]).length).toBe(3);
  });

  it('renders a sitemap and robots.txt', () => {
    const sitemap = renderSitemap('https://acmeroofing.ca', [page([]), page([], { path: '/contact' })]);
    expect(sitemap).toContain('<loc>https://acmeroofing.ca/</loc>');
    expect(sitemap).toContain('<loc>https://acmeroofing.ca/contact</loc>');

    expect(renderRobotsTxt('https://acmeroofing.ca')).toContain('Sitemap: https://acmeroofing.ca/sitemap.xml');
    expect(renderRobotsTxt('https://acmeroofing.ca', { allowIndexing: false })).toContain('Disallow: /');
  });
});

describe('on-page SEO audit', () => {
  it('flags a missing description and missing H1', () => {
    const codes = auditPageSeo(page([block('text', { body: 'x'.repeat(200) })], {
      seo: { noindex: false, metaTitle: 'A reasonable page title here' },
    })).map((i) => i.code);
    expect(codes).toContain('missing_description');
    expect(codes).toContain('missing_h1');
  });

  it('flags multiple heroes as multiple H1s', () => {
    const p = page([block('hero', { heading: 'One' }), block('hero', { heading: 'Two' })]);
    expect(auditPageSeo(p).map((i) => i.code)).toContain('multiple_h1');
  });

  it('flags images without alt text', () => {
    const p = page([block('gallery', { images: [{ url: '/a.jpg' }, { url: '/b.jpg', alt: 'ok' }] })]);
    const issue = auditPageSeo(p).find((i) => i.code === 'images_missing_alt');
    expect(issue?.message).toContain('1 image');
  });

  it('does not mistake a testimonial for an image', () => {
    const p = page([block('testimonials', { items: [{ quote: 'Great work', author: 'Dana' }] })]);
    expect(auditPageSeo(p).some((i) => i.code === 'images_missing_alt')).toBe(false);
  });

  it('flags an over-long title', () => {
    const p = page([], { seo: { noindex: false, metaTitle: 'x'.repeat(80) } });
    expect(auditPageSeo(p).map((i) => i.code)).toContain('title_too_long');
  });
});
