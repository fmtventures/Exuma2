import { z } from 'zod';

/**
 * Block schema.
 *
 * A page is an ordered list of blocks. Blocks are data, never markup — which
 * is what makes AI-generated pages fully editable afterwards, lets one page
 * render to HTML/AMP/preview from the same source, and keeps change sets
 * addressable down to `blocks.3.props.heading`.
 *
 * Every block carries responsive and visibility settings in a shared envelope
 * so the editor's controls work identically across block types.
 */

export const BLOCK_TYPES = [
  'hero', 'text', 'text_image', 'gallery', 'testimonials', 'services',
  'products', 'faq', 'team', 'contact', 'map', 'form', 'cta', 'banner',
  'event', 'calendar', 'booking', 'pricing', 'stats', 'logo_cloud',
  'video', 'downloads', 'social_feed', 'spacer', 'html', 'custom',
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export type Breakpoint = 'mobile' | 'tablet' | 'desktop' | 'wide';

export const BREAKPOINT_MIN_WIDTH: Record<Breakpoint, number> = {
  mobile: 0,
  tablet: 768,
  desktop: 1024,
  wide: 1440,
};

const responsiveValue = <T extends z.ZodTypeAny>(inner: T) =>
  z.union([
    inner,
    z.object({
      mobile: inner.optional(),
      tablet: inner.optional(),
      desktop: inner.optional(),
      wide: inner.optional(),
    }),
  ]);

export const BlockStyleSchema = z.object({
  /** Token names, not raw values — keeps the brand kit authoritative. */
  background: z.string().optional(),
  textColor: z.string().optional(),
  paddingTop: responsiveValue(z.string()).optional(),
  paddingBottom: responsiveValue(z.string()).optional(),
  maxWidth: z.string().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  /** Dark sections invert the token set rather than hard-coding colours. */
  scheme: z.enum(['light', 'dark', 'inherit']).default('inherit'),
  animation: z.enum(['none', 'fade', 'slide-up', 'zoom']).default('none'),
  customClass: z.string().optional(),
});

export const BlockVisibilitySchema = z.object({
  hiddenOn: z.array(z.enum(['mobile', 'tablet', 'desktop', 'wide'])).default([]),
  /** Scheduled visibility — powers announcements and promotions. */
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  requiresAuth: z.boolean().default(false),
});

export const BlockSchema = z.object({
  id: z.string(),
  type: z.enum(BLOCK_TYPES),
  /** Block-type-specific content; validated by PROP_SCHEMAS below. */
  props: z.record(z.unknown()).default({}),
  style: BlockStyleSchema.default({ scheme: 'inherit', animation: 'none' }),
  visibility: BlockVisibilitySchema.default({ hiddenOn: [], requiresAuth: false }),
  /** Set when this block is an instance of a reusable component. */
  componentId: z.string().optional(),
  /** Locked blocks cannot be edited by lower roles (agency-managed sites). */
  locked: z.boolean().default(false),
});

export type Block = z.infer<typeof BlockSchema>;

/* ------------------------------------------------------------------ */
/* Per-type property schemas                                           */
/* ------------------------------------------------------------------ */

const imageRef = z.object({
  assetId: z.string().optional(),
  url: z.string().optional(),
  alt: z.string().optional(),
  focalPoint: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
});

const link = z.object({
  label: z.string(),
  href: z.string(),
  style: z.enum(['primary', 'secondary', 'ghost', 'link']).default('primary'),
  newTab: z.boolean().default(false),
});

export const PROP_SCHEMAS: Partial<Record<BlockType, z.ZodTypeAny>> = {
  hero: z.object({
    heading: z.string(),
    subheading: z.string().optional(),
    eyebrow: z.string().optional(),
    image: imageRef.optional(),
    /** Overlay keeps text legible over photography at every breakpoint. */
    overlay: z.enum(['none', 'dark', 'light', 'gradient']).default('none'),
    layout: z.enum(['centered', 'left', 'split', 'full_bleed']).default('centered'),
    buttons: z.array(link).default([]),
    height: z.enum(['small', 'medium', 'large', 'viewport']).default('medium'),
  }),

  text: z.object({
    heading: z.string().optional(),
    body: z.string(),
    columns: z.number().int().min(1).max(3).default(1),
  }),

  text_image: z.object({
    heading: z.string().optional(),
    body: z.string(),
    image: imageRef,
    imagePosition: z.enum(['left', 'right']).default('right'),
    buttons: z.array(link).default([]),
  }),

  gallery: z.object({
    heading: z.string().optional(),
    images: z.array(imageRef).default([]),
    layout: z.enum(['grid', 'masonry', 'carousel', 'justified']).default('grid'),
    columns: z.number().int().min(1).max(6).default(3),
    lightbox: z.boolean().default(true),
  }),

  testimonials: z.object({
    heading: z.string().optional(),
    /** Either inline items or a live query against the knowledge graph. */
    items: z.array(z.object({
      quote: z.string(),
      author: z.string().optional(),
      role: z.string().optional(),
      rating: z.number().min(0).max(5).optional(),
      image: imageRef.optional(),
    })).default([]),
    source: z.enum(['inline', 'collection']).default('inline'),
    collectionId: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(6),
    layout: z.enum(['cards', 'carousel', 'single', 'wall']).default('cards'),
  }),

  services: z.object({
    heading: z.string().optional(),
    intro: z.string().optional(),
    source: z.enum(['inline', 'collection']).default('collection'),
    collectionId: z.string().optional(),
    items: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      icon: z.string().optional(),
      image: imageRef.optional(),
      href: z.string().optional(),
      price: z.string().optional(),
    })).default([]),
    columns: z.number().int().min(1).max(4).default(3),
    layout: z.enum(['cards', 'list', 'icons', 'alternating']).default('cards'),
  }),

  team: z.object({
    heading: z.string().optional(),
    source: z.enum(['inline', 'collection']).default('collection'),
    collectionId: z.string().optional(),
    members: z.array(z.object({
      name: z.string(),
      role: z.string().optional(),
      bio: z.string().optional(),
      image: imageRef.optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    })).default([]),
    columns: z.number().int().min(1).max(5).default(3),
    /** Normalized headshots are what make a team grid look professional. */
    photoShape: z.enum(['circle', 'square', 'portrait']).default('circle'),
  }),

  faq: z.object({
    heading: z.string().optional(),
    source: z.enum(['inline', 'collection']).default('collection'),
    collectionId: z.string().optional(),
    items: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
    layout: z.enum(['accordion', 'list', 'two_column']).default('accordion'),
    /** Emits FAQPage structured data when true. */
    emitSchema: z.boolean().default(true),
  }),

  contact: z.object({
    heading: z.string().optional(),
    showPhone: z.boolean().default(true),
    showEmail: z.boolean().default(true),
    showAddress: z.boolean().default(true),
    showHours: z.boolean().default(true),
    locationId: z.string().optional(),
    formId: z.string().optional(),
  }),

  form: z.object({
    formId: z.string(),
    heading: z.string().optional(),
    description: z.string().optional(),
    submitLabel: z.string().default('Send'),
    successMessage: z.string().default('Thanks — we\'ll be in touch shortly.'),
    layout: z.enum(['stacked', 'two_column', 'inline']).default('stacked'),
  }),

  cta: z.object({
    heading: z.string(),
    body: z.string().optional(),
    buttons: z.array(link).min(1),
    layout: z.enum(['banner', 'card', 'split']).default('banner'),
  }),

  banner: z.object({
    message: z.string(),
    link: link.optional(),
    dismissible: z.boolean().default(true),
    tone: z.enum(['info', 'promo', 'warning', 'urgent']).default('info'),
    position: z.enum(['top', 'bottom', 'inline']).default('top'),
  }),

  pricing: z.object({
    heading: z.string().optional(),
    tiers: z.array(z.object({
      name: z.string(),
      price: z.string(),
      period: z.string().optional(),
      description: z.string().optional(),
      features: z.array(z.string()).default([]),
      button: link.optional(),
      highlighted: z.boolean().default(false),
    })).default([]),
  }),

  stats: z.object({
    heading: z.string().optional(),
    items: z.array(z.object({
      value: z.string(),
      label: z.string(),
      description: z.string().optional(),
    })).default([]),
  }),

  logo_cloud: z.object({
    heading: z.string().optional(),
    logos: z.array(imageRef).default([]),
    grayscale: z.boolean().default(true),
  }),

  video: z.object({
    url: z.string(),
    poster: imageRef.optional(),
    caption: z.string().optional(),
    autoplay: z.boolean().default(false),
    loop: z.boolean().default(false),
    muted: z.boolean().default(true),
  }),

  map: z.object({
    locationId: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    zoom: z.number().int().min(1).max(20).default(14),
    height: z.string().default('400px'),
    showDirectionsLink: z.boolean().default(true),
  }),

  downloads: z.object({
    heading: z.string().optional(),
    files: z.array(z.object({
      title: z.string(),
      url: z.string(),
      sizeBytes: z.number().optional(),
      mimeType: z.string().optional(),
    })).default([]),
  }),

  event: z.object({
    source: z.enum(['inline', 'collection']).default('collection'),
    collectionId: z.string().optional(),
    eventId: z.string().optional(),
    layout: z.enum(['card', 'detail', 'list']).default('card'),
    showRegistration: z.boolean().default(true),
  }),

  calendar: z.object({
    collectionId: z.string().optional(),
    view: z.enum(['list', 'month', 'week', 'agenda']).default('month'),
    categories: z.array(z.string()).default([]),
    showPastEvents: z.boolean().default(false),
  }),

  booking: z.object({
    serviceIds: z.array(z.string()).default([]),
    providerIds: z.array(z.string()).default([]),
    heading: z.string().optional(),
    /** Provider-agnostic: native scheduler or a connected integration. */
    provider: z.string().default('native'),
  }),

  products: z.object({
    heading: z.string().optional(),
    collectionId: z.string().optional(),
    productIds: z.array(z.string()).default([]),
    columns: z.number().int().min(1).max(5).default(4),
    limit: z.number().int().min(1).max(60).default(12),
    showPrice: z.boolean().default(true),
    showAddToCart: z.boolean().default(true),
  }),

  social_feed: z.object({
    network: z.string(),
    handle: z.string().optional(),
    limit: z.number().int().min(1).max(24).default(6),
  }),

  spacer: z.object({
    height: responsiveValue(z.string()).default('48px'),
  }),

  html: z.object({
    /** Sanitized on render; see render/html.ts. */
    content: z.string(),
  }),
};

export function propSchemaFor(type: BlockType): z.ZodTypeAny {
  return PROP_SCHEMAS[type] ?? z.record(z.unknown());
}

export interface BlockValidationIssue {
  blockId: string;
  blockType: BlockType;
  path: string;
  message: string;
}

/** Validate a block's props against its type schema. */
export function validateBlock(block: Block): BlockValidationIssue[] {
  const result = propSchemaFor(block.type).safeParse(block.props);
  if (result.success) return [];
  return result.error.issues.map((i) => ({
    blockId: block.id,
    blockType: block.type,
    path: i.path.join('.'),
    message: i.message,
  }));
}

/** Resolve a responsive value at a breakpoint, falling back down the ladder. */
export function resolveResponsive<T>(
  value: T | Partial<Record<Breakpoint, T>> | undefined,
  breakpoint: Breakpoint,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) return value as T;
  const map = value as Partial<Record<Breakpoint, T>>;
  const ladder: Breakpoint[] = ['wide', 'desktop', 'tablet', 'mobile'];
  const from = ladder.indexOf(breakpoint);
  for (let i = from; i < ladder.length; i++) {
    const key = ladder[i] as Breakpoint;
    if (map[key] !== undefined) return map[key];
  }
  return undefined;
}

export function isVisibleAt(block: Block, breakpoint: Breakpoint, at: Date = new Date()): boolean {
  if (block.visibility.hiddenOn.includes(breakpoint)) return false;
  if (block.visibility.startsAt && Date.parse(block.visibility.startsAt) > at.getTime()) return false;
  if (block.visibility.endsAt && Date.parse(block.visibility.endsAt) <= at.getTime()) return false;
  return true;
}
