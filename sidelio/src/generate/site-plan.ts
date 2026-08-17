import { newId } from '../core/ids.ts';
import type { Block, BlockType } from '../blocks/schema.ts';
import { normalizePath, slugify, type Page, type Navigation, type NavigationItem } from '../blocks/page.ts';
import type { KnowledgeGraph } from '../knowledge/graph.ts';
import type { Entity } from '../knowledge/entities.ts';
import { themeFor, schemeFor, type ConceptDirection } from './concept-themes.ts';
import { templateById } from './templates.ts';

/**
 * Site generation — the rebuild modes.
 *
 * Takes a Business Knowledge Graph and produces a complete page tree. The mode
 * changes *what* gets built and *how much* is preserved; the output shape is
 * identical in every mode so the before/after comparison, the editor, and the
 * renderer never need to care which one ran.
 *
 * Critically: only publishable facts are used. A business whose phone number is
 * still unverified gets a contact page without a phone number and a review
 * prompt — never an invented one.
 */

export type RebuildMode =
  /** Preserve the source structure and content; rebuild on Sidelio primitives. */
  | 'faithful'
  /** Same content and identity, modernized layout, spacing, mobile and CTAs. */
  | 'modernize'
  /** Keep the business facts, generate a new design direction and structure. */
  | 'redesign'
  /** Proven content architecture for the detected industry. */
  | 'industry_optimized'
  /** Optimize for conversion, speed, SEO and accessibility above all. */
  | 'performance_first';

export interface GenerateOptions {
  mode: RebuildMode;
  /** Only used by the three-concepts flow. */
  direction?: ConceptDirection;
  /** Design library template; overrides the direction when both are given. */
  templateId?: string;
  /** Pages carried over from Smart Import, with their review decisions. */
  importedPages?: Array<{ url: string; path: string; title: string; kind: string; decision: string }>;
  industry?: IndustryKey;
  locale?: string;
}

export interface GeneratedSite {
  pages: Page[];
  navigation: Navigation[];
  /** Facts the generator wanted but could not use — drives the review nudge. */
  missing: MissingFact[];
  notes: string[];
}

export interface MissingFact {
  path: string;
  label: string;
  /** What the site is missing because of it. */
  impact: string;
}

/* ------------------------------------------------------------------ */
/* Industry content architectures                                      */
/* ------------------------------------------------------------------ */

export type IndustryKey =
  | 'trades' | 'professional_services' | 'real_estate' | 'restaurant'
  | 'retail' | 'health' | 'fitness' | 'hospitality' | 'nonprofit'
  | 'education' | 'automotive' | 'events' | 'generic';

interface PagePlan {
  path: string;
  title: string;
  kind: string;
  blocks: BlockType[];
  /** Included only when the graph has the data to fill it. */
  requires?: Array<'Service' | 'Product' | 'Employee' | 'Testimonial' | 'FAQ' | 'Article' | 'Event' | 'Location'>;
}

const BASE_PAGES: PagePlan[] = [
  { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'services', 'text_image', 'testimonials', 'cta'] },
  { path: '/about', title: 'About', kind: 'about', blocks: ['hero', 'text_image', 'stats', 'team', 'cta'] },
  { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'contact', 'map'] },
];

export const INDUSTRY_ARCHITECTURES: Record<IndustryKey, PagePlan[]> = {
  trades: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'services', 'stats', 'testimonials', 'gallery', 'cta'] },
    { path: '/services', title: 'Services', kind: 'services', blocks: ['hero', 'services', 'faq', 'cta'], requires: ['Service'] },
    { path: '/projects', title: 'Our Work', kind: 'gallery', blocks: ['hero', 'gallery', 'testimonials', 'cta'] },
    { path: '/about', title: 'About', kind: 'about', blocks: ['hero', 'text_image', 'team', 'stats', 'cta'] },
    { path: '/contact', title: 'Request a Quote', kind: 'contact', blocks: ['hero', 'form', 'contact', 'map'] },
  ],
  professional_services: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'services', 'logo_cloud', 'testimonials', 'cta'] },
    { path: '/services', title: 'Services', kind: 'services', blocks: ['hero', 'services', 'faq', 'cta'], requires: ['Service'] },
    { path: '/team', title: 'Our Team', kind: 'team', blocks: ['hero', 'team', 'cta'], requires: ['Employee'] },
    { path: '/insights', title: 'Insights', kind: 'blog_index', blocks: ['hero', 'text'], requires: ['Article'] },
    { path: '/about', title: 'About', kind: 'about', blocks: ['hero', 'text_image', 'stats', 'cta'] },
    { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'form', 'contact', 'map'] },
  ],
  real_estate: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'services', 'gallery', 'team', 'testimonials', 'cta'] },
    { path: '/listings', title: 'Listings', kind: 'products', blocks: ['hero', 'products', 'cta'] },
    { path: '/team', title: 'Our Agents', kind: 'team', blocks: ['hero', 'team', 'cta'], requires: ['Employee'] },
    { path: '/about', title: 'About', kind: 'about', blocks: ['hero', 'text_image', 'stats', 'testimonials'] },
    { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'form', 'contact', 'map'] },
  ],
  restaurant: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'text_image', 'gallery', 'testimonials', 'cta'] },
    { path: '/menu', title: 'Menu', kind: 'products', blocks: ['hero', 'products'] },
    { path: '/reservations', title: 'Reservations', kind: 'contact', blocks: ['hero', 'booking', 'contact'] },
    { path: '/contact', title: 'Find Us', kind: 'contact', blocks: ['hero', 'contact', 'map'] },
  ],
  retail: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'products', 'text_image', 'testimonials', 'cta'] },
    { path: '/shop', title: 'Shop', kind: 'products', blocks: ['hero', 'products'], requires: ['Product'] },
    { path: '/about', title: 'About', kind: 'about', blocks: ['hero', 'text_image', 'stats'] },
    { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'contact', 'map'] },
  ],
  health: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'services', 'team', 'testimonials', 'cta'] },
    { path: '/services', title: 'Services', kind: 'services', blocks: ['hero', 'services', 'faq'], requires: ['Service'] },
    { path: '/team', title: 'Our Team', kind: 'team', blocks: ['hero', 'team'], requires: ['Employee'] },
    { path: '/book', title: 'Book an Appointment', kind: 'contact', blocks: ['hero', 'booking', 'contact'] },
    { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'contact', 'map'] },
  ],
  fitness: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'services', 'pricing', 'testimonials', 'cta'] },
    { path: '/classes', title: 'Classes', kind: 'services', blocks: ['hero', 'calendar', 'services'] },
    { path: '/pricing', title: 'Membership', kind: 'pricing', blocks: ['hero', 'pricing', 'faq', 'cta'] },
    { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'contact', 'map'] },
  ],
  hospitality: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'gallery', 'services', 'testimonials', 'cta'] },
    { path: '/rooms', title: 'Rooms', kind: 'products', blocks: ['hero', 'products', 'faq'] },
    { path: '/book', title: 'Book', kind: 'contact', blocks: ['hero', 'booking'] },
    { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'contact', 'map'] },
  ],
  nonprofit: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'stats', 'text_image', 'cta', 'testimonials'] },
    { path: '/programs', title: 'Programs', kind: 'services', blocks: ['hero', 'services'], requires: ['Service'] },
    { path: '/events', title: 'Events', kind: 'events', blocks: ['hero', 'calendar'], requires: ['Event'] },
    { path: '/donate', title: 'Donate', kind: 'contact', blocks: ['hero', 'cta', 'form'] },
    { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'contact', 'map'] },
  ],
  education: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'services', 'stats', 'testimonials', 'cta'] },
    { path: '/programs', title: 'Programs', kind: 'services', blocks: ['hero', 'services', 'faq'], requires: ['Service'] },
    { path: '/events', title: 'Events', kind: 'events', blocks: ['hero', 'calendar'], requires: ['Event'] },
    { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'form', 'contact', 'map'] },
  ],
  automotive: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'products', 'services', 'testimonials', 'cta'] },
    { path: '/inventory', title: 'Inventory', kind: 'products', blocks: ['hero', 'products'] },
    { path: '/services', title: 'Service', kind: 'services', blocks: ['hero', 'services', 'booking'], requires: ['Service'] },
    { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'contact', 'map'] },
  ],
  events: [
    { path: '/', title: 'Home', kind: 'home', blocks: ['hero', 'calendar', 'gallery', 'testimonials', 'cta'] },
    { path: '/events', title: 'Events', kind: 'events', blocks: ['hero', 'calendar'], requires: ['Event'] },
    { path: '/contact', title: 'Contact', kind: 'contact', blocks: ['hero', 'form', 'contact'] },
  ],
  generic: BASE_PAGES,
};

const INDUSTRY_KEYWORDS: Array<[IndustryKey, RegExp]> = [
  ['trades', /roofing|plumb|electric|hvac|contractor|construction|landscap|renovat|paving|excavat|masonry|carpent/i],
  ['real_estate', /real estate|realtor|realty|broker|property management|listings?/i],
  ['restaurant', /restaurant|cafe|caf[ée]|bistro|diner|pizzeria|catering|bakery|brewery|pub\b/i],
  ['health', /clinic|dental|dentist|chiropract|physio|medical|health|therapy|optometr|veterinar|wellness/i],
  ['fitness', /gym|fitness|yoga|pilates|crossfit|training studio|martial arts/i],
  ['hospitality', /hotel|inn\b|cottage|resort|bed and breakfast|b&b|lodge|rental|vacation/i],
  ['nonprofit', /nonprofit|non-profit|charity|foundation|society|association|volunteer/i],
  ['education', /school|academy|college|university|tutoring|courses?|training centre|training center/i],
  ['automotive', /auto|car dealer|dealership|mechanic|tire|collision|body shop/i],
  ['retail', /shop|store|boutique|retail|goods|supply/i],
  ['events', /events?|wedding|venue|conference|festival/i],
  ['professional_services', /law|legal|attorney|accounting|accountant|consult|agency|insurance|financial|architect|engineering|marketing/i],
];

/** Guess an industry from the business profile. Always overridable by the user. */
export function detectIndustry(graph: KnowledgeGraph): IndustryKey {
  const business = graph.byType('Business')[0];
  const services = graph.byType('Service').map((s) => String(s['name'] ?? '')).join(' ');
  const hay = [
    business?.['name'], business?.['description'], business?.['industry'], services,
  ].filter(Boolean).join(' ');

  for (const [key, re] of INDUSTRY_KEYWORDS) {
    if (re.test(hay)) return key;
  }
  return 'generic';
}

/* ------------------------------------------------------------------ */
/* Mode profiles                                                       */
/* ------------------------------------------------------------------ */

interface ModeProfile {
  /** Extra blocks appended to every page. */
  alwaysAppend: BlockType[];
  /** Section order for the home page; overrides the industry default. */
  homeSections?: BlockType[];
  heroOverlay?: 'none' | 'dark' | 'light' | 'gradient';
  /** Applied to every block, so a dark direction does not paint light-on-light. */
  scheme?: 'light' | 'dark' | 'inherit';
  /** Blocks dropped for speed/simplicity. */
  suppress: BlockType[];
  heroHeight: 'small' | 'medium' | 'large' | 'viewport';
  heroLayout: 'centered' | 'left' | 'split' | 'full_bleed';
  animation: 'none' | 'fade' | 'slide-up' | 'zoom';
  /** Whether to reuse the source site's page structure verbatim. */
  preserveSourceStructure: boolean;
}

const MODE_PROFILES: Record<RebuildMode, ModeProfile> = {
  faithful: {
    alwaysAppend: [], suppress: [], heroHeight: 'medium', heroLayout: 'centered',
    animation: 'none', preserveSourceStructure: true,
  },
  modernize: {
    alwaysAppend: ['cta'], suppress: ['social_feed'], heroHeight: 'large', heroLayout: 'split',
    animation: 'fade', preserveSourceStructure: true,
  },
  redesign: {
    alwaysAppend: ['cta'], suppress: [], heroHeight: 'viewport', heroLayout: 'full_bleed',
    animation: 'slide-up', preserveSourceStructure: false,
  },
  industry_optimized: {
    alwaysAppend: ['cta'], suppress: [], heroHeight: 'large', heroLayout: 'split',
    animation: 'fade', preserveSourceStructure: false,
  },
  performance_first: {
    // Carousels, social embeds and video backgrounds are the usual culprits
    // behind poor mobile scores, so this mode simply refuses to emit them.
    alwaysAppend: ['cta'], suppress: ['social_feed', 'video', 'gallery'],
    heroHeight: 'medium', heroLayout: 'left', animation: 'none', preserveSourceStructure: false,
  },
};

/**
 * A concept direction overrides the whole profile — layout, motion and the
 * section composition — and separately supplies its own brand kit. Varying
 * only the hero produced three pages that were indistinguishable.
 */
function profileForDirection(direction: ConceptDirection): Partial<ModeProfile> {
  const theme = themeFor(direction);
  return {
    heroHeight: theme.hero.height,
    heroLayout: theme.hero.layout,
    heroOverlay: theme.hero.overlay,
    animation: theme.animation,
    scheme: schemeFor(direction),
    homeSections: theme.homeSections,
    alwaysAppend: theme.interiorTail,
  };
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

export function generateSite(
  siteId: string,
  graph: KnowledgeGraph,
  options: GenerateOptions,
): GeneratedSite {
  const industry = options.industry ?? detectIndustry(graph);
  const template = options.templateId ? templateById(options.templateId) : undefined;
  const profile = {
    ...MODE_PROFILES[options.mode],
    ...(options.direction ? profileForDirection(options.direction) : {}),
    ...(template
      ? {
          heroHeight: template.hero.height,
          heroLayout: template.hero.layout,
          heroOverlay: template.hero.overlay,
          animation: template.animation,
          homeSections: template.homeSections,
        }
      : {}),
  };
  const locale = options.locale ?? 'en';
  const missing: MissingFact[] = [];
  const notes: string[] = [];

  // Publishable projections only — this is the gate that keeps unverified
  // facts off generated pages.
  const business = firstPublishable(graph, 'Business');
  const services = publishableList(graph, 'Service');
  const employees = publishableList(graph, 'Employee');
  const testimonials = publishableList(graph, 'Testimonial');
  const faqs = publishableList(graph, 'FAQ');
  const products = publishableList(graph, 'Product');
  const articles = publishableList(graph, 'Article');
  const events = publishableList(graph, 'Event');
  const locations = publishableList(graph, 'Location');
  const contacts = publishableList(graph, 'ContactPoint');

  if (!business?.['name']) {
    missing.push({ path: 'business.name', label: 'Business name', impact: 'Headings and page titles fall back to a placeholder.' });
  }
  if (!contacts.some((c) => c['contactType'] === 'phone')) {
    missing.push({ path: 'business.phone', label: 'Phone number', impact: 'Call buttons and the contact block are omitted.' });
  }
  if (locations.length === 0) {
    missing.push({ path: 'business.address', label: 'Address', impact: 'The map block and location schema are omitted.' });
  }

  const available: AvailabilityCounts = {
    Service: services.length, Product: products.length, Employee: employees.length,
    Testimonial: testimonials.length, FAQ: faqs.length, Article: articles.length,
    Event: events.length, Location: locations.length,
  };

  // Choose the page plan.
  let plans: PagePlan[];
  if (profile.preserveSourceStructure && options.importedPages?.length) {
    plans = options.importedPages
      .filter((p) => p.decision !== 'ignore' && p.decision !== 'archive')
      .map((p) => ({
        path: normalizePath(p.path),
        title: p.title,
        kind: p.kind,
        blocks: blocksForKind(p.kind, available),
      }));
    if (!plans.some((p) => p.path === '/')) {
      plans.unshift({ path: '/', title: 'Home', kind: 'home', blocks: blocksForKind('home', available) });
    }
    notes.push(`Preserved ${plans.length} page(s) from the existing site.`);
  } else {
    plans = INDUSTRY_ARCHITECTURES[industry];
    notes.push(`Applied the ${industry.replace(/_/g, ' ')} content architecture.`);
  }

  // Drop pages whose required data is absent, and blocks we cannot fill.
  const pages: Page[] = [];
  let order = 0;
  for (const plan of plans) {
    if (plan.requires?.some((r) => available[r] === 0)) {
      notes.push(`Skipped "${plan.title}" — no ${plan.requires.join('/')} content was found.`);
      continue;
    }

    const planned = plan.kind === 'home' && profile.homeSections
      ? profile.homeSections
      : plan.blocks;

    const blockTypes = [...planned, ...profile.alwaysAppend]
      .filter((t) => !profile.suppress.includes(t))
      .filter((t, i, arr) => arr.indexOf(t) === i);

    const blocks: Block[] = [];
    for (const type of blockTypes) {
      const block = buildBlock(type, {
        profile, plan, business, services, employees, testimonials, faqs,
        products, articles, events, locations, contacts,
      });
      if (block) blocks.push(block);
    }

    pages.push({
      id: newId('page'),
      siteId,
      path: plan.path,
      title: plan.title,
      blocks,
      seo: {
        metaTitle: `${plan.title}${business?.['name'] ? ` | ${business['name']}` : ''}`,
        ...(descriptionFor(plan, business) ? { metaDescription: descriptionFor(plan, business) } : {}),
        noindex: false,
      },
      status: 'draft',
      ...(template ? { layout: template.layout, treatments: template.treatments } : {}),
      order: order++,
      locale,
      updatedAt: new Date().toISOString(),
    });
  }

  // Dynamic detail pages from collections.
  if (services.length > 0 && !pages.some((p) => p.path === '/services')) {
    notes.push('Service detail pages are generated from the Services collection.');
  }

  const navigation = buildNavigation(siteId, pages);
  return { pages, navigation, missing, notes };
}

type AvailabilityCounts = Record<
  'Service' | 'Product' | 'Employee' | 'Testimonial' | 'FAQ' | 'Article' | 'Event' | 'Location',
  number
>;

function blocksForKind(kind: string, available: AvailabilityCounts): BlockType[] {
  const map: Record<string, BlockType[]> = {
    home: ['hero', 'services', 'text_image', 'testimonials', 'cta'],
    about: ['hero', 'text_image', 'stats', 'team'],
    services: ['hero', 'services', 'faq'],
    service_detail: ['hero', 'text', 'faq', 'cta'],
    products: ['hero', 'products'],
    product_detail: ['hero', 'text', 'products'],
    contact: ['hero', 'form', 'contact', 'map'],
    team: ['hero', 'team'],
    blog_index: ['hero', 'text'],
    article: ['hero', 'text'],
    faq: ['hero', 'faq'],
    testimonials: ['hero', 'testimonials'],
    events: ['hero', 'calendar'],
    gallery: ['hero', 'gallery'],
    pricing: ['hero', 'pricing', 'faq'],
    legal: ['hero', 'text'],
    careers: ['hero', 'text', 'form'],
    location: ['hero', 'contact', 'map'],
    other: ['hero', 'text'],
  };
  const chosen = map[kind] ?? map['other'] as BlockType[];
  // Never emit a collection-backed block with nothing to show.
  return chosen.filter((t) => {
    if (t === 'services') return available['Service'] > 0;
    if (t === 'products') return available['Product'] > 0;
    if (t === 'team') return available['Employee'] > 0;
    if (t === 'testimonials') return available['Testimonial'] > 0;
    if (t === 'faq') return available['FAQ'] > 0;
    if (t === 'calendar') return available['Event'] > 0;
    if (t === 'map') return available['Location'] > 0;
    return true;
  });
}

interface BuildContext {
  profile: ModeProfile;
  plan: PagePlan;
  business?: Entity;
  services: Entity[];
  employees: Entity[];
  testimonials: Entity[];
  faqs: Entity[];
  products: Entity[];
  articles: Entity[];
  events: Entity[];
  locations: Entity[];
  contacts: Entity[];
}

function block(type: BlockType, props: Record<string, unknown>, ctx: BuildContext): Block {
  return {
    id: newId('page'),
    type,
    props,
    style: { scheme: ctx.profile.scheme ?? 'inherit', animation: ctx.profile.animation },
    visibility: { hiddenOn: [], requiresAuth: false },
    locked: false,
  };
}

function buildBlock(type: BlockType, ctx: BuildContext): Block | null {
  const name = String(ctx.business?.['name'] ?? 'Our business');
  const description = String(ctx.business?.['description'] ?? '');

  switch (type) {
    case 'hero':
      return block('hero', {
        heading: ctx.plan.kind === 'home' ? name : ctx.plan.title,
        ...(ctx.plan.kind === 'home' && description ? { subheading: truncate(description, 180) } : {}),
        overlay: ctx.profile.heroOverlay ?? 'gradient',
        layout: ctx.profile.heroLayout,
        height: ctx.plan.kind === 'home' ? ctx.profile.heroHeight : 'small',
        buttons: heroButtons(ctx),
      }, ctx);

    case 'services':
      if (ctx.services.length === 0) return null;
      return block('services', {
        heading: 'What we do',
        source: 'inline',
        items: ctx.services.slice(0, 9).map((s) => ({
          name: String(s['name']),
          ...(s['shortDescription'] || s['description']
            ? { description: truncate(String(s['shortDescription'] ?? s['description']), 200) }
            : {}),
          href: `/services/${slugify(String(s['name']))}`,
        })),
        columns: ctx.services.length >= 3 ? 3 : ctx.services.length,
        layout: 'cards',
      }, ctx);

    case 'products':
      if (ctx.products.length === 0) return null;
      return block('products', {
        heading: 'Featured',
        productIds: ctx.products.slice(0, 12).map((p) => p.id),
        columns: 4,
        limit: 12,
        showPrice: true,
        showAddToCart: true,
      }, ctx);

    case 'team':
      if (ctx.employees.length === 0) return null;
      return block('team', {
        heading: 'Meet the team',
        source: 'inline',
        members: ctx.employees.slice(0, 24).map((e) => ({
          name: String(e['name']),
          ...(e['role'] ? { role: String(e['role']) } : {}),
          ...(e['bio'] ? { bio: truncate(String(e['bio']), 300) } : {}),
        })),
        columns: 3,
        photoShape: 'circle',
      }, ctx);

    case 'testimonials':
      if (ctx.testimonials.length === 0) return null;
      return block('testimonials', {
        heading: 'What our customers say',
        source: 'inline',
        items: ctx.testimonials.slice(0, 9).map((t) => ({
          quote: String(t['quote']),
          ...(t['authorName'] ? { author: String(t['authorName']) } : {}),
          ...(typeof t['rating'] === 'number' ? { rating: t['rating'] } : {}),
        })),
        layout: ctx.testimonials.length >= 3 ? 'cards' : 'single',
      }, ctx);

    case 'faq':
      if (ctx.faqs.length === 0) return null;
      return block('faq', {
        heading: 'Frequently asked questions',
        source: 'inline',
        items: ctx.faqs.slice(0, 20).map((f) => ({ question: String(f['question']), answer: String(f['answer']) })),
        layout: 'accordion',
        emitSchema: true,
      }, ctx);

    case 'text_image':
      if (!description) return null;
      return block('text_image', {
        heading: `About ${name}`,
        body: description,
        image: {},
        imagePosition: 'right',
        buttons: [],
      }, ctx);

    case 'text':
      return block('text', {
        ...(ctx.plan.kind === 'home' ? {} : { heading: ctx.plan.title }),
        body: description || 'Add your content here.',
        columns: 1,
      }, ctx);

    case 'contact': {
      const phone = ctx.contacts.find((c) => c['contactType'] === 'phone');
      const email = ctx.contacts.find((c) => c['contactType'] === 'email');
      const location = ctx.locations[0];
      return block('contact', {
        heading: 'Get in touch',
        showPhone: Boolean(phone),
        showEmail: Boolean(email),
        showAddress: Boolean(location),
        showHours: Boolean(location?.['hours']),
        ...(location ? { locationId: location.id } : {}),
      }, ctx);
    }

    case 'map':
      if (ctx.locations.length === 0) return null;
      return block('map', {
        locationId: ctx.locations[0]?.id,
        zoom: 14,
        height: '400px',
        showDirectionsLink: true,
      }, ctx);

    case 'form':
      return block('form', {
        formId: 'contact',
        heading: 'Send us a message',
        submitLabel: 'Send',
        successMessage: 'Thanks — we\'ll be in touch shortly.',
        layout: 'stacked',
      }, ctx);

    case 'cta': {
      const phone = ctx.contacts.find((c) => c['contactType'] === 'phone');
      const buttons = phone
        ? [{ label: `Call ${phone['value']}`, href: `tel:${String(phone['value']).replace(/\D/g, '')}`, style: 'primary', newTab: false },
           { label: 'Contact us', href: '/contact', style: 'secondary', newTab: false }]
        : [{ label: 'Contact us', href: '/contact', style: 'primary', newTab: false }];
      return block('cta', {
        heading: 'Ready to get started?',
        body: `Talk to ${name} today.`,
        buttons,
        layout: 'banner',
      }, ctx);
    }

    case 'stats':
      return block('stats', { heading: 'By the numbers', items: [] }, ctx);

    case 'gallery':
      return block('gallery', { heading: 'Gallery', images: [], layout: 'grid', columns: 3, lightbox: true }, ctx);

    case 'calendar':
      if (ctx.events.length === 0) return null;
      return block('calendar', { view: 'month', categories: [], showPastEvents: false }, ctx);

    case 'pricing':
      return block('pricing', { heading: 'Pricing', tiers: [] }, ctx);

    case 'booking':
      return block('booking', { heading: 'Book online', serviceIds: ctx.services.slice(0, 10).map((s) => s.id), providerIds: [], provider: 'native' }, ctx);

    case 'logo_cloud':
      return block('logo_cloud', { logos: [], grayscale: true }, ctx);

    default:
      return null;
  }
}

function heroButtons(ctx: BuildContext) {
  const phone = ctx.contacts.find((c) => c['contactType'] === 'phone');
  const buttons: Array<Record<string, unknown>> = [];
  if (ctx.plan.kind !== 'contact') {
    buttons.push({ label: 'Get in touch', href: '/contact', style: 'primary', newTab: false });
  }
  if (phone) {
    buttons.push({
      label: `Call ${phone['value']}`,
      href: `tel:${String(phone['value']).replace(/\D/g, '')}`,
      style: buttons.length === 0 ? 'primary' : 'secondary',
      newTab: false,
    });
  }
  return buttons;
}

function buildNavigation(siteId: string, pages: Page[]): Navigation[] {
  const items: NavigationItem[] = pages
    .filter((p) => p.path !== '/')
    .sort((a, b) => a.order - b.order)
    .slice(0, 7)
    .map((p) => ({ id: newId('page'), label: p.title, pageId: p.id, children: [] }));

  return [
    { id: newId('page'), siteId, slot: 'header', items },
    {
      id: newId('page'),
      siteId,
      slot: 'footer',
      items: [
        ...items,
        { id: newId('page'), label: 'Privacy', href: '/privacy', children: [] },
      ],
    },
  ];
}

function descriptionFor(plan: PagePlan, business?: Entity): string | undefined {
  const name = business?.['name'];
  const desc = business?.['description'];
  if (plan.kind === 'home' && typeof desc === 'string' && desc) return truncate(desc, 155);
  if (typeof name === 'string' && name) return truncate(`${plan.title} at ${name}.`, 155);
  return undefined;
}

function firstPublishable(graph: KnowledgeGraph, type: Parameters<KnowledgeGraph['byType']>[0]): Entity | undefined {
  const first = graph.byType(type)[0];
  return first ? graph.publishableEntity(first.id) : undefined;
}

function publishableList(graph: KnowledgeGraph, type: Parameters<KnowledgeGraph['byType']>[0]): Entity[] {
  return graph.byType(type)
    .map((e) => graph.publishableEntity(e.id))
    .filter((e): e is Entity => e !== undefined)
    // A record whose defining field never cleared review is not usable.
    .filter((e) => definingFieldPresent(e));
}

function definingFieldPresent(entity: Entity): boolean {
  switch (entity.type) {
    case 'Testimonial': return typeof entity['quote'] === 'string' && entity['quote'].length > 0;
    case 'FAQ': return Boolean(entity['question'] && entity['answer']);
    case 'Article': return typeof entity['title'] === 'string' && entity['title'].length > 0;
    case 'ContactPoint': return typeof entity['value'] === 'string' && entity['value'].length > 0;
    case 'Location': return Boolean(entity['address']);
    default: return typeof entity['name'] === 'string' && entity['name'].length > 0;
  }
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Generate the three AI concepts the spec calls for, in one pass. */
export function generateThreeConcepts(
  siteId: string,
  graph: KnowledgeGraph,
  base: Omit<GenerateOptions, 'direction'>,
): Record<ConceptDirection, GeneratedSite> {
  return {
    conservative: generateSite(siteId, graph, { ...base, direction: 'conservative' }),
    modern: generateSite(siteId, graph, { ...base, direction: 'modern' }),
    bold: generateSite(siteId, graph, { ...base, direction: 'bold' }),
  };
}
