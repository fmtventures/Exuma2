import { parse, type HTMLElement } from 'node-html-parser';
import {
  classifySocialUrl, findAddresses, findEmails, findOpeningHours, findPhones,
  type AddressCandidate, type Candidate, type HoursEntry,
} from './contacts.ts';
import { parseJsonLdBlocks, readSocialMeta, type StructuredNode } from './schema-org.ts';

/**
 * HTML page extractor.
 *
 * Produces a structured, source-attributed view of a single page: what it says,
 * what it links to, what media it uses, what the business appears to be, and
 * what is technically wrong with it. The pipeline turns that into knowledge
 * graph facts; the audit turns the technical findings into the migration
 * warnings shown before publish.
 */

export interface HeadingNode {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface LinkRef {
  href: string;
  text: string;
  rel?: string;
  /** Resolved absolute URL when the href could be resolved. */
  absolute?: string;
  internal: boolean;
}

export interface ImageRef {
  src: string;
  absolute?: string;
  alt?: string;
  width?: number;
  height?: number;
  /** True when the image sits above the fold in source order. */
  likelyHero: boolean;
  lazy: boolean;
}

export interface NavItem {
  label: string;
  href?: string;
  children: NavItem[];
}

export interface FormField {
  name: string;
  label?: string;
  inputType: string;
  required: boolean;
  options: string[];
}

export interface FormRef {
  action?: string;
  method: string;
  fields: FormField[];
  submitLabel?: string;
}

export interface TrackingTag {
  /** ga4, gtm, meta_pixel, hotjar, linkedin, tiktok, clarity, other */
  vendor: string;
  id?: string;
}

export type AuditSeverity = 'info' | 'warning' | 'error';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  message: string;
  /** What Sidelio will do about it during rebuild. */
  remediation?: string;
}

export interface ExtractedPage {
  url: string;
  title?: string;
  metaDescription?: string;
  canonical?: string;
  lang?: string;
  robotsMeta?: string;
  headings: HeadingNode[];
  /** Main body text with nav/footer/script chrome removed. */
  text: string;
  wordCount: number;
  navigation: NavItem[];
  footerLinks: LinkRef[];
  links: LinkRef[];
  images: ImageRef[];
  videos: string[];
  documents: LinkRef[];
  forms: FormRef[];
  ctas: Array<{ label: string; href?: string }>;
  socialProfiles: Array<{ network: string; url: string; handle?: string }>;
  structuredData: StructuredNode[];
  openGraph: Record<string, string>;
  phones: Candidate<string>[];
  emails: Candidate<string>[];
  addresses: Candidate<AddressCandidate>[];
  openingHours: Candidate<HoursEntry[]>[];
  faqs: Array<{ question: string; answer: string }>;
  testimonials: Array<{ quote: string; author?: string }>;
  tracking: TrackingTag[];
  audit: AuditFinding[];
  /** Signals used later to classify page purpose (home, service, contact…). */
  pageKind: PageKind;
}

export type PageKind =
  | 'home' | 'about' | 'services' | 'service_detail' | 'products' | 'product_detail'
  | 'contact' | 'team' | 'blog_index' | 'article' | 'faq' | 'testimonials'
  | 'events' | 'gallery' | 'pricing' | 'legal' | 'careers' | 'location' | 'other';

const CHROME_SELECTORS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe'];

const DOC_EXTENSIONS = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|rtf|odt)(\?|$)/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg|bmp|tiff?)(\?|$)/i;

const CTA_PATTERNS = [
  /\bcall (?:us|now|today)\b/i, /\bget (?:a )?(?:free )?(?:quote|estimate)\b/i,
  /\bbook (?:now|online|an appointment|a consultation)\b/i, /\bcontact us\b/i,
  /\brequest (?:a )?(?:quote|demo|info)/i, /\bshop now\b/i, /\bbuy now\b/i,
  /\bsign up\b/i, /\bsubscribe\b/i, /\blearn more\b/i, /\bget started\b/i,
  /\bschedule\b/i, /\bapply now\b/i, /\bdownload\b/i, /\bview (?:menu|listings|inventory)\b/i,
];

function absolutize(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

function sameHost(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, '');
    const hb = new URL(b).hostname.replace(/^www\./, '');
    return ha === hb;
  } catch {
    return false;
  }
}

function cleanText(node: HTMLElement): string {
  return node.text.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/** Best-effort main-content region, falling back to body. */
function mainRegion(root: HTMLElement): HTMLElement {
  for (const sel of ['main', 'article', '[role=main]', '#main', '#content', '.main-content']) {
    const found = root.querySelector(sel);
    if (found && found.text.trim().length > 200) return found;
  }
  return root;
}

function buildNav(container: HTMLElement | null, base: string): NavItem[] {
  if (!container) return [];
  const lists = container.querySelectorAll('ul');
  const topLevel = lists.find((ul) => !ul.parentNode?.closest?.('ul')) ?? lists[0];
  if (!topLevel) {
    // Nav without lists — take direct anchors.
    return container.querySelectorAll('a').slice(0, 12).map((a) => ({
      label: a.text.trim(),
      href: absolutize(a.getAttribute('href') ?? '', base),
      children: [],
    })).filter((i) => i.label);
  }

  const items: NavItem[] = [];
  for (const li of topLevel.childNodes.filter((n): n is HTMLElement => (n as HTMLElement).tagName === 'LI')) {
    const anchor = li.querySelector('a');
    const label = (anchor?.text ?? li.text).trim().split('\n')[0]?.trim() ?? '';
    if (!label) continue;
    const sub = li.querySelector('ul');
    const children: NavItem[] = sub
      ? sub.querySelectorAll('a').map((a) => ({
          label: a.text.trim(),
          href: absolutize(a.getAttribute('href') ?? '', base),
          children: [],
        })).filter((c) => c.label)
      : [];
    const item: NavItem = { label, children };
    const href = anchor?.getAttribute('href');
    if (href) item.href = absolutize(href, base);
    items.push(item);
  }
  return items;
}

function extractForms(root: HTMLElement, base: string): FormRef[] {
  return root.querySelectorAll('form').map((form) => {
    const fields: FormField[] = [];
    for (const el of form.querySelectorAll('input, textarea, select')) {
      const type = (el.getAttribute('type') ?? (el.tagName === 'SELECT' ? 'select' : el.tagName.toLowerCase())).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      const name = el.getAttribute('name') ?? el.getAttribute('id') ?? '';
      if (!name) continue;

      const id = el.getAttribute('id');
      const labelEl = id ? form.querySelector(`label[for="${id}"]`) : null;
      const label = labelEl?.text.trim() || el.getAttribute('placeholder') || el.getAttribute('aria-label');

      const options = el.tagName === 'SELECT'
        ? el.querySelectorAll('option').map((o) => o.text.trim()).filter(Boolean)
        : [];

      const field: FormField = {
        name,
        inputType: type,
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
        options,
      };
      if (label) field.label = label;
      fields.push(field);
    }

    const submit = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
    const ref: FormRef = {
      method: (form.getAttribute('method') ?? 'get').toLowerCase(),
      fields,
    };
    const action = form.getAttribute('action');
    if (action) ref.action = absolutize(action, base) ?? action;
    const submitLabel = submit?.text.trim() || submit?.getAttribute('value');
    if (submitLabel) ref.submitLabel = submitLabel;
    return ref;
  });
}

function detectTracking(html: string): TrackingTag[] {
  const tags: TrackingTag[] = [];
  const push = (vendor: string, id?: string) => {
    if (!tags.some((t) => t.vendor === vendor && t.id === id)) {
      tags.push(id ? { vendor, id } : { vendor });
    }
  };

  for (const m of html.matchAll(/G-[A-Z0-9]{6,12}/g)) push('ga4', m[0]);
  for (const m of html.matchAll(/GTM-[A-Z0-9]{4,10}/g)) push('gtm', m[0]);
  for (const m of html.matchAll(/UA-\d{4,10}-\d{1,4}/g)) push('universal_analytics', m[0]);
  if (/connect\.facebook\.net|fbq\s*\(/.test(html)) {
    const id = /fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,20})['"]/.exec(html)?.[1];
    push('meta_pixel', id);
  }
  if (/static\.hotjar\.com|hjid\s*:/.test(html)) push('hotjar');
  if (/snap\.licdn\.com|_linkedin_partner_id/.test(html)) push('linkedin');
  if (/analytics\.tiktok\.com/.test(html)) push('tiktok');
  if (/clarity\.ms/.test(html)) push('clarity');
  if (/cookieyes|cookiebot|osano|onetrust|termly/i.test(html)) push('cookie_consent');
  return tags;
}

function extractFaqs(root: HTMLElement): Array<{ question: string; answer: string }> {
  const out: Array<{ question: string; answer: string }> = [];

  // Definition lists are the cleanest signal.
  for (const dl of root.querySelectorAll('dl')) {
    const children = dl.childNodes.filter((n): n is HTMLElement => !!(n as HTMLElement).tagName);
    for (let i = 0; i < children.length - 1; i++) {
      const dt = children[i];
      const dd = children[i + 1];
      if (dt?.tagName === 'DT' && dd?.tagName === 'DD') {
        out.push({ question: dt.text.trim(), answer: dd.text.trim() });
      }
    }
  }

  // Accordion patterns: a heading ending in "?" followed by a text block.
  for (const heading of root.querySelectorAll('h2, h3, h4, summary, .accordion-title, .faq-question')) {
    const q = heading.text.trim();
    if (!q.endsWith('?') || q.length > 300) continue;
    const sibling = heading.nextElementSibling;
    const answer = sibling ? cleanText(sibling) : '';
    if (answer.length > 10 && answer.length < 4000) out.push({ question: q, answer });
  }

  const seen = new Set<string>();
  return out.filter((f) => {
    const key = f.question.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractTestimonials(root: HTMLElement): Array<{ quote: string; author?: string }> {
  const out: Array<{ quote: string; author?: string }> = [];
  const candidates = [
    ...root.querySelectorAll('blockquote'),
    ...root.querySelectorAll('[class*=testimonial]'),
    ...root.querySelectorAll('[class*=review]'),
    ...root.querySelectorAll('figure.quote'),
  ];

  for (const el of candidates) {
    const cite = el.querySelector('cite, footer, .author, .testimonial-author');
    const author = cite?.text.trim();
    let quote = cleanText(el);
    if (author && quote.endsWith(author)) quote = quote.slice(0, -author.length).trim();
    quote = quote.replace(/^["“”'']+|["“”'']+$/g, '').replace(/[—–-]\s*$/, '').trim();
    if (quote.length < 25 || quote.length > 2000) continue;
    if (out.some((t) => t.quote === quote)) continue;
    out.push(author ? { quote, author } : { quote });
  }
  return out;
}

function classifyPage(url: string, title: string | undefined, headings: HeadingNode[]): PageKind {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  const hay = `${path} ${title ?? ''} ${headings.slice(0, 3).map((h) => h.text).join(' ')}`.toLowerCase();

  if (path === '/' || path === '' || path === '/index.html' || path === '/home') return 'home';

  const rules: Array<[RegExp, PageKind]> = [
    [/contact|get-in-touch|reach-us/, 'contact'],
    [/about|our-story|who-we-are|history/, 'about'],
    [/\b(team|staff|our-people|agents|meet-the)/, 'team'],
    [/(faq|frequently-asked|questions)/, 'faq'],
    [/testimonial|reviews?/, 'testimonials'],
    [/(privacy|terms|cookie|accessibility|legal|disclaimer)/, 'legal'],
    [/(careers?|jobs|employment|hiring|join-us)/, 'careers'],
    [/(blog|news|articles|insights)$/, 'blog_index'],
    [/(blog|news|articles|insights)\//, 'article'],
    [/(events?|calendar)/, 'events'],
    [/(gallery|portfolio|projects|photos)/, 'gallery'],
    [/(pricing|plans|rates|packages)/, 'pricing'],
    [/(locations?|branches|find-us|directions)/, 'location'],
    [/(shop|products?|store|catalog)\//, 'product_detail'],
    [/(shop|products?|store|catalog)/, 'products'],
    [/(services?|what-we-do|solutions)\/.+/, 'service_detail'],
    [/(services?|what-we-do|solutions)/, 'services'],
  ];
  for (const [re, kind] of rules) {
    if (re.test(hay)) return kind;
  }
  return 'other';
}

function auditPage(page: Omit<ExtractedPage, 'audit' | 'pageKind'>, htmlLength: number): AuditFinding[] {
  const findings: AuditFinding[] = [];

  if (!page.title) {
    findings.push({ code: 'missing_title', severity: 'error', message: 'Page has no <title>.', remediation: 'Sidelio will generate a title from the page content.' });
  } else if (page.title.length > 60) {
    findings.push({ code: 'title_too_long', severity: 'warning', message: `Title is ${page.title.length} characters; search results truncate around 60.`, remediation: 'Sidelio will propose a shorter title.' });
  }

  if (!page.metaDescription) {
    findings.push({ code: 'missing_meta_description', severity: 'warning', message: 'No meta description.', remediation: 'Sidelio will write one from the page content.' });
  } else if (page.metaDescription.length > 160) {
    findings.push({ code: 'meta_description_too_long', severity: 'info', message: 'Meta description exceeds 160 characters.' });
  }

  const h1s = page.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    findings.push({ code: 'missing_h1', severity: 'warning', message: 'No H1 heading.', remediation: 'Sidelio will promote the page title to an H1.' });
  } else if (h1s.length > 1) {
    findings.push({ code: 'multiple_h1', severity: 'info', message: `${h1s.length} H1 headings found.`, remediation: 'Sidelio will keep one H1 and demote the rest.' });
  }

  const noAlt = page.images.filter((i) => !i.alt || i.alt.trim() === '');
  if (noAlt.length > 0) {
    findings.push({
      code: 'images_missing_alt',
      severity: 'error',
      message: `${noAlt.length} of ${page.images.length} images have no alt text.`,
      remediation: 'AI Media Studio will generate alt text for each, for your review.',
    });
  }

  const notLazy = page.images.filter((i) => !i.lazy && !i.likelyHero);
  if (notLazy.length > 3) {
    findings.push({ code: 'images_not_lazy', severity: 'info', message: `${notLazy.length} below-the-fold images load eagerly.`, remediation: 'Sidelio lazy-loads non-hero images automatically.' });
  }

  if (page.structuredData.length === 0) {
    findings.push({ code: 'no_structured_data', severity: 'warning', message: 'No schema.org structured data.', remediation: 'Sidelio emits structured data from your business profile.' });
  }

  if (!page.canonical) {
    findings.push({ code: 'missing_canonical', severity: 'info', message: 'No canonical URL declared.' });
  }

  if (page.wordCount < 100) {
    findings.push({ code: 'thin_content', severity: 'warning', message: `Only ${page.wordCount} words of content.`, remediation: 'Flagged for review — thin pages rarely rank.' });
  }

  if (htmlLength > 500_000) {
    findings.push({ code: 'large_html', severity: 'warning', message: `HTML payload is ${Math.round(htmlLength / 1024)} KB.`, remediation: 'The rebuilt page ships a fraction of this.' });
  }

  if (page.forms.length > 0) {
    const missingLabels = page.forms.flatMap((f) => f.fields.filter((x) => !x.label));
    if (missingLabels.length > 0) {
      findings.push({ code: 'form_fields_missing_labels', severity: 'error', message: `${missingLabels.length} form fields have no label.`, remediation: 'Rebuilt forms always carry accessible labels.' });
    }
  }

  return findings;
}

export function extractPage(html: string, url: string): ExtractedPage {
  const root = parse(html, { blockTextElements: { script: true, style: true, noscript: false } });

  const jsonLdBlocks = root.querySelectorAll('script[type="application/ld+json"]').map((s) => s.text);
  const structuredData = parseJsonLdBlocks(jsonLdBlocks);

  const metas = root.querySelectorAll('meta').map((m) => ({
    property: m.getAttribute('property'),
    name: m.getAttribute('name'),
    content: m.getAttribute('content'),
  }));
  const openGraph = readSocialMeta(metas);

  const metaBy = (key: string) =>
    metas.find((m) => (m.name ?? '').toLowerCase() === key)?.content;

  const navContainer = root.querySelector('nav') ?? root.querySelector('header nav') ?? root.querySelector('[role=navigation]');
  const navigation = buildNav(navContainer, url);

  const footer = root.querySelector('footer');
  const footerLinks: LinkRef[] = (footer?.querySelectorAll('a') ?? []).map((a) => {
    const href = a.getAttribute('href') ?? '';
    const absolute = absolutize(href, url);
    const ref: LinkRef = { href, text: a.text.trim(), internal: absolute ? sameHost(absolute, url) : false };
    if (absolute) ref.absolute = absolute;
    return ref;
  });

  const links: LinkRef[] = root.querySelectorAll('a').map((a) => {
    const href = a.getAttribute('href') ?? '';
    const absolute = absolutize(href, url);
    const ref: LinkRef = { href, text: a.text.trim(), internal: absolute ? sameHost(absolute, url) : false };
    if (absolute) ref.absolute = absolute;
    const rel = a.getAttribute('rel');
    if (rel) ref.rel = rel;
    return ref;
  }).filter((l) => l.href && !l.href.startsWith('javascript:'));

  const allImgs = root.querySelectorAll('img');
  const images: ImageRef[] = allImgs.map((img, index) => {
    const src = img.getAttribute('src') ?? img.getAttribute('data-src') ?? '';
    const absolute = absolutize(src, url);
    const w = Number(img.getAttribute('width'));
    const h = Number(img.getAttribute('height'));
    const ref: ImageRef = {
      src,
      likelyHero: index < 2,
      lazy: img.getAttribute('loading') === 'lazy',
    };
    if (absolute) ref.absolute = absolute;
    const alt = img.getAttribute('alt');
    if (alt !== null && alt !== undefined) ref.alt = alt;
    if (Number.isFinite(w) && w > 0) ref.width = w;
    if (Number.isFinite(h) && h > 0) ref.height = h;
    return ref;
  }).filter((i) => i.src);

  const videos = [
    ...root.querySelectorAll('video source').map((s) => s.getAttribute('src') ?? ''),
    ...root.querySelectorAll('video').map((v) => v.getAttribute('src') ?? ''),
    ...root.querySelectorAll('iframe')
      .map((f) => f.getAttribute('src') ?? '')
      .filter((s) => /youtube|youtu\.be|vimeo|wistia|loom/.test(s)),
  ].filter(Boolean).map((s) => absolutize(s, url) ?? s);

  const documents = links.filter((l) => DOC_EXTENSIONS.test(l.href));

  const socialSeen = new Map<string, { network: string; url: string; handle?: string }>();
  for (const l of links) {
    if (!l.absolute) continue;
    const classified = classifySocialUrl(l.absolute);
    if (!classified) continue;
    const key = `${classified.network}:${classified.handle ?? ''}`;
    if (!socialSeen.has(key)) {
      socialSeen.set(key, classified.handle
        ? { network: classified.network, url: l.absolute, handle: classified.handle }
        : { network: classified.network, url: l.absolute });
    }
  }

  const ctas = links
    .filter((l) => CTA_PATTERNS.some((re) => re.test(l.text)) || l.href.startsWith('tel:') || l.href.startsWith('mailto:'))
    .map((l) => (l.absolute ? { label: l.text || l.href, href: l.absolute } : { label: l.text || l.href }))
    .filter((c) => c.label)
    .slice(0, 30);

  // Strip chrome before reading body text so nav labels do not pollute content.
  const contentRoot = mainRegion(root);
  for (const sel of CHROME_SELECTORS) {
    for (const el of contentRoot.querySelectorAll(sel)) el.remove();
  }
  const text = cleanText(contentRoot);
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  const headings: HeadingNode[] = root.querySelectorAll('h1, h2, h3, h4, h5, h6').map((h) => ({
    level: Number(h.tagName.slice(1)) as HeadingNode['level'],
    text: h.text.trim(),
  })).filter((h) => h.text);

  // Contact details: `tel:`/`mailto:` links are far stronger evidence than
  // pattern matches in prose, and footers beat body copy.
  const phones = [
    ...links.filter((l) => l.href.startsWith('tel:'))
      .flatMap((l) => findPhones(decodeURIComponent(l.href.slice(4)), 'tel: link', 0.95)),
    ...(footer ? findPhones(cleanText(footer), 'footer', 0.8) : []),
    ...findPhones(text, 'page body', 0.55),
  ];
  const emails = [
    ...links.filter((l) => l.href.startsWith('mailto:'))
      .flatMap((l) => findEmails(decodeURIComponent(l.href.slice(7)), 'mailto: link', 0.95)),
    ...(footer ? findEmails(cleanText(footer), 'footer', 0.85) : []),
    ...findEmails(text, 'page body', 0.6),
  ];

  const addressSearchText = [
    ...(footer ? [footer.structuredText] : []),
    ...root.querySelectorAll('address').map((a) => a.structuredText),
    contentRoot.structuredText,
  ].join('\n');
  const addresses = findAddresses(addressSearchText, 'address block / footer');
  const openingHours = findOpeningHours(addressSearchText, 'hours block');

  const forms = extractForms(root, url);
  const faqs = extractFaqs(root);
  const testimonials = extractTestimonials(root);
  const tracking = detectTracking(html);

  const partial: Omit<ExtractedPage, 'audit' | 'pageKind'> = {
    url,
    ...(root.querySelector('title')?.text.trim() ? { title: root.querySelector('title')?.text.trim() } : {}),
    ...(metaBy('description') ? { metaDescription: metaBy('description') } : {}),
    ...(root.querySelector('link[rel=canonical]')?.getAttribute('href')
      ? { canonical: absolutize(root.querySelector('link[rel=canonical]')?.getAttribute('href') ?? '', url) }
      : {}),
    ...(root.querySelector('html')?.getAttribute('lang') ? { lang: root.querySelector('html')?.getAttribute('lang') } : {}),
    ...(metaBy('robots') ? { robotsMeta: metaBy('robots') } : {}),
    headings,
    text,
    wordCount,
    navigation,
    footerLinks,
    links,
    images,
    videos,
    documents,
    forms,
    ctas,
    socialProfiles: [...socialSeen.values()],
    structuredData,
    openGraph,
    phones,
    emails,
    addresses,
    openingHours,
    faqs,
    testimonials,
    tracking,
  };

  return {
    ...partial,
    audit: auditPage(partial, html.length),
    pageKind: classifyPage(url, partial.title, headings),
  };
}

/** Collect internal, crawlable URLs from an extracted page. */
export function crawlableLinks(page: ExtractedPage): string[] {
  const out = new Set<string>();
  for (const link of page.links) {
    if (!link.internal || !link.absolute) continue;
    if (DOC_EXTENSIONS.test(link.absolute) || IMAGE_EXTENSIONS.test(link.absolute)) continue;
    if (link.rel?.includes('nofollow')) continue;
    const url = new URL(link.absolute);
    url.hash = '';
    out.add(url.toString());
  }
  return [...out];
}
