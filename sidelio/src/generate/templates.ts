import type { BlockType } from '../blocks/schema.ts';
import type { BrandKit } from '../design/brand-kit.ts';
import type { IndustryKey } from './site-plan.ts';

/**
 * Design library.
 *
 * A browsable set of complete designs a user picks from, rather than variants
 * generated from one kit. Each template is a full design system — palette,
 * type pairing, scale, shape language, hero treatment and section composition
 * — so two templates differ the way two real websites differ, not by a
 * changed accent colour.
 *
 * Every template renders from the same Business Knowledge Graph, so switching
 * design never touches content. That is the whole point of keeping blocks as
 * data: the business facts stay put and the design around them is swappable.
 */

export interface SiteTemplate {
  id: string;
  name: string;
  /** One line on who it suits — shown under the name in the gallery. */
  tagline: string;
  /** Industries it was designed around; the gallery filters on these. */
  industries: IndustryKey[];
  /** Short descriptors for filtering by feel. */
  tags: string[];
  brand: (base: BrandKit) => BrandKit;
  hero: {
    layout: 'centered' | 'left' | 'split' | 'full_bleed';
    height: 'small' | 'medium' | 'large' | 'viewport';
    overlay: 'none' | 'dark' | 'light' | 'gradient';
  };
  animation: 'none' | 'fade' | 'slide-up' | 'zoom';
  homeSections: BlockType[];
}

/* Type stacks. System and open-source only — a published site must not depend
   on a font CDN, so every stack degrades to something installed. */
const SERIF_CLASSIC = 'Iowan Old Style, Palatino Linotype, Palatino, Georgia, serif';
const SERIF_SHARP = 'Charter, Bitstream Charter, Georgia, "Times New Roman", serif';
const SERIF_BOOK = 'Georgia, Cambria, "Times New Roman", serif';
const SANS_GEO = 'Avenir Next, Avenir, Nunito Sans, system-ui, sans-serif';
const SANS_GROTESK = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const SANS_SYSTEM = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SANS_UI = 'Inter, system-ui, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

type Shape = BrandKit['shape'];

const SQUARE = (base: Shape): Shape => ({
  ...base, radiusSm: '0', radiusMd: '0', radiusLg: '0', radiusFull: '0',
  shadowSm: 'none', shadowMd: 'none', shadowLg: 'none',
});
const CRISP = (base: Shape): Shape => ({
  ...base, radiusSm: '2px', radiusMd: '3px', radiusLg: '4px',
  shadowSm: 'none', shadowMd: '0 1px 0 rgb(0 0 0 / 0.08)', shadowLg: '0 2px 0 rgb(0 0 0 / 0.10)',
});
const SOFT = (base: Shape, tint = '15 23 42'): Shape => ({
  ...base, radiusSm: '8px', radiusMd: '14px', radiusLg: '24px',
  shadowSm: `0 1px 3px rgb(${tint} / 0.08)`,
  shadowMd: `0 8px 24px rgb(${tint} / 0.10)`,
  shadowLg: `0 20px 48px rgb(${tint} / 0.14)`,
});
const PILL = (base: Shape, tint = '15 23 42'): Shape => ({
  ...SOFT(base, tint), radiusSm: '10px', radiusMd: '999px', radiusLg: '32px',
});

/** Build a template's brand function from its distinctive parts. */
function kit(spec: {
  colors: Partial<BrandKit['colors']>;
  type: Partial<BrandKit['typography']>;
  shape: (base: Shape) => Shape;
  imageStyle: BrandKit['imageStyle'];
}) {
  return (base: BrandKit): BrandKit => ({
    ...base,
    colors: { ...base.colors, ...spec.colors },
    typography: { ...base.typography, ...spec.type },
    shape: spec.shape(base.shape),
    imageStyle: spec.imageStyle,
  });
}

export const TEMPLATES: SiteTemplate[] = [
  {
    id: 'ironclad',
    name: 'Ironclad',
    tagline: 'Heavy, high-contrast and built to be remembered from a truck door.',
    industries: ['trades', 'automotive'],
    tags: ['dark', 'bold', 'high-contrast'],
    brand: kit({
      colors: {
        primary: '#f59f00', secondary: '#111315', accent: '#ff6b35',
        background: '#111315', surface: '#1c1f22', text: '#f5f3f0',
        textMuted: '#b3b8bd', border: '#32383d',
      },
      type: {
        headingFamily: SANS_GROTESK, bodyFamily: SANS_SYSTEM, ratio: 1.42,
        baseSizePx: 18, headingWeight: 800, headingLineHeight: 0.98, letterSpacing: '-0.03em',
      },
      shape: SQUARE,
      imageStyle: ['cinematic', 'architectural'],
    }),
    hero: { layout: 'full_bleed', height: 'viewport', overlay: 'none' },
    animation: 'slide-up',
    homeSections: ['hero', 'services', 'gallery', 'stats', 'cta', 'testimonials'],
  },
  {
    id: 'harbour',
    name: 'Harbour',
    tagline: 'Established and trust-led. Reads as a firm with decades behind it.',
    industries: ['trades', 'professional_services', 'generic'],
    tags: ['classic', 'serif', 'light'],
    brand: kit({
      colors: {
        primary: '#1f3a5f', secondary: '#2f3e46', accent: '#8a6f48',
        background: '#ffffff', surface: '#f4f2ee', text: '#1c232b',
        textMuted: '#54606c', border: '#dcd8d0',
      },
      type: {
        headingFamily: SERIF_CLASSIC, bodyFamily: SANS_SYSTEM, ratio: 1.2,
        baseSizePx: 17, headingWeight: 700, headingLineHeight: 1.2, letterSpacing: '0',
      },
      shape: CRISP,
      imageStyle: ['documentary', 'natural'],
    }),
    hero: { layout: 'left', height: 'medium', overlay: 'light' },
    animation: 'none',
    homeSections: ['hero', 'stats', 'services', 'testimonials', 'text_image', 'cta'],
  },
  {
    id: 'seagrass',
    name: 'Seagrass',
    tagline: 'Clean and current. Generous spacing, soft edges, easy on a phone.',
    industries: ['generic', 'health', 'professional_services'],
    tags: ['modern', 'airy', 'light'],
    brand: kit({
      colors: {
        primary: '#0f766e', secondary: '#134e4a', accent: '#f59e0b',
        background: '#ffffff', surface: '#f0fdfa', text: '#111f22',
        textMuted: '#4b5f63', border: '#d5e7e4',
      },
      type: {
        headingFamily: SANS_GEO, bodyFamily: SANS_GEO, ratio: 1.28,
        baseSizePx: 17, headingWeight: 700, headingLineHeight: 1.15, letterSpacing: '-0.015em',
      },
      shape: (b) => SOFT(b, '15 118 110'),
      imageStyle: ['bright', 'natural'],
    }),
    hero: { layout: 'split', height: 'large', overlay: 'none' },
    animation: 'fade',
    homeSections: ['hero', 'services', 'text_image', 'stats', 'testimonials', 'gallery', 'cta'],
  },
  {
    id: 'salt-cedar',
    name: 'Salt & Cedar',
    tagline: 'Warm and hospitable, for places people stay and eat.',
    industries: ['hospitality', 'restaurant'],
    tags: ['warm', 'editorial', 'serif'],
    brand: kit({
      colors: {
        primary: '#8c4a2f', secondary: '#3d2b23', accent: '#c98a3d',
        background: '#fbf7f1', surface: '#f3ebe0', text: '#2b211b',
        textMuted: '#6b5a4d', border: '#e2d5c4',
      },
      type: {
        headingFamily: SERIF_BOOK, bodyFamily: SANS_SYSTEM, ratio: 1.33,
        baseSizePx: 18, headingWeight: 600, headingLineHeight: 1.1, letterSpacing: '-0.01em',
      },
      shape: CRISP,
      imageStyle: ['warm', 'editorial'],
    }),
    hero: { layout: 'full_bleed', height: 'large', overlay: 'gradient' },
    animation: 'fade',
    homeSections: ['hero', 'text_image', 'gallery', 'testimonials', 'cta'],
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    tagline: 'Technical and precise, with a drawing-office feel.',
    industries: ['trades', 'professional_services', 'education'],
    tags: ['technical', 'mono', 'light'],
    brand: kit({
      colors: {
        primary: '#1d4ed8', secondary: '#1e293b', accent: '#0ea5e9',
        background: '#f8fafc', surface: '#eef2f7', text: '#0f172a',
        textMuted: '#475569', border: '#cbd5e1',
      },
      type: {
        headingFamily: SANS_UI, bodyFamily: SANS_UI, ratio: 1.22,
        baseSizePx: 16, headingWeight: 700, headingLineHeight: 1.2, letterSpacing: '-0.02em',
      },
      shape: SQUARE,
      imageStyle: ['architectural', 'minimal'],
    }),
    hero: { layout: 'left', height: 'medium', overlay: 'none' },
    animation: 'none',
    homeSections: ['hero', 'stats', 'services', 'faq', 'cta'],
  },
  {
    id: 'meridian',
    name: 'Meridian',
    tagline: 'Quiet luxury for property and high-value services.',
    industries: ['real_estate', 'hospitality', 'professional_services'],
    tags: ['luxury', 'minimal', 'serif'],
    brand: kit({
      colors: {
        primary: '#0f1c2e', secondary: '#1b2a41', accent: '#b08d57',
        background: '#ffffff', surface: '#f7f6f3', text: '#111827',
        textMuted: '#5b6472', border: '#e6e2da',
      },
      type: {
        headingFamily: SERIF_SHARP, bodyFamily: SANS_GEO, ratio: 1.35,
        baseSizePx: 17, headingWeight: 500, headingLineHeight: 1.08, letterSpacing: '-0.02em',
      },
      shape: CRISP,
      imageStyle: ['luxury', 'editorial'],
    }),
    hero: { layout: 'full_bleed', height: 'viewport', overlay: 'gradient' },
    animation: 'fade',
    homeSections: ['hero', 'gallery', 'services', 'stats', 'testimonials', 'cta'],
  },
  {
    id: 'field-notes',
    name: 'Field Notes',
    tagline: 'Plain-spoken and text-forward, for writing that carries the site.',
    industries: ['professional_services', 'nonprofit', 'education', 'generic'],
    tags: ['editorial', 'text-first', 'light'],
    brand: kit({
      colors: {
        primary: '#166534', secondary: '#14532d', accent: '#ca8a04',
        background: '#fdfdfc', surface: '#f4f5f2', text: '#1a1c19',
        textMuted: '#55605a', border: '#dfe3dc',
      },
      type: {
        headingFamily: SERIF_SHARP, bodyFamily: SERIF_SHARP, ratio: 1.24,
        baseSizePx: 19, headingWeight: 700, lineHeight: 1.75, headingLineHeight: 1.2, letterSpacing: '0',
      },
      shape: CRISP,
      imageStyle: ['documentary', 'natural'],
    }),
    hero: { layout: 'left', height: 'small', overlay: 'none' },
    animation: 'none',
    homeSections: ['hero', 'text_image', 'services', 'faq', 'cta'],
  },
  {
    id: 'signal',
    name: 'Signal',
    tagline: 'Bright and energetic, built around a strong call to action.',
    industries: ['fitness', 'events', 'retail'],
    tags: ['vivid', 'rounded', 'energetic'],
    brand: kit({
      colors: {
        primary: '#e11d48', secondary: '#4c0519', accent: '#f97316',
        background: '#ffffff', surface: '#fff1f2', text: '#1a0b0f',
        textMuted: '#6b5057', border: '#fbd5db',
      },
      type: {
        headingFamily: SANS_GEO, bodyFamily: SANS_SYSTEM, ratio: 1.38,
        baseSizePx: 17, headingWeight: 800, headingLineHeight: 1.02, letterSpacing: '-0.03em',
      },
      shape: (b) => PILL(b, '225 29 72'),
      imageStyle: ['bright', 'playful'],
    }),
    hero: { layout: 'centered', height: 'large', overlay: 'none' },
    animation: 'zoom',
    homeSections: ['hero', 'stats', 'services', 'pricing', 'testimonials', 'cta'],
  },
  {
    id: 'nightshift',
    name: 'Nightshift',
    tagline: 'Dark and modern, for studios and technical work.',
    industries: ['professional_services', 'automotive', 'generic'],
    tags: ['dark', 'modern', 'minimal'],
    brand: kit({
      colors: {
        primary: '#7c9cff', secondary: '#0b0d12', accent: '#4ade80',
        background: '#0b0d12', surface: '#141821', text: '#e8ecf4',
        textMuted: '#98a2b8', border: '#242b38',
      },
      type: {
        headingFamily: SANS_UI, bodyFamily: SANS_UI, ratio: 1.3,
        baseSizePx: 17, headingWeight: 700, headingLineHeight: 1.08, letterSpacing: '-0.025em',
      },
      shape: (b) => SOFT(b, '0 0 0'),
      imageStyle: ['cinematic', 'minimal'],
    }),
    hero: { layout: 'split', height: 'large', overlay: 'none' },
    animation: 'fade',
    homeSections: ['hero', 'services', 'stats', 'gallery', 'cta'],
  },
  {
    id: 'clinic',
    name: 'Clinic',
    tagline: 'Calm and reassuring, designed to reduce anxiety before a visit.',
    industries: ['health', 'nonprofit'],
    tags: ['calm', 'accessible', 'light'],
    brand: kit({
      colors: {
        primary: '#0369a1', secondary: '#075985', accent: '#059669',
        background: '#ffffff', surface: '#f0f9ff', text: '#0c1b26',
        textMuted: '#4a6070', border: '#d8e9f2',
      },
      type: {
        headingFamily: SANS_SYSTEM, bodyFamily: SANS_SYSTEM, ratio: 1.22,
        baseSizePx: 18, headingWeight: 600, lineHeight: 1.75, headingLineHeight: 1.25, letterSpacing: '0',
      },
      shape: (b) => SOFT(b, '3 105 161'),
      imageStyle: ['bright', 'natural'],
    }),
    hero: { layout: 'left', height: 'medium', overlay: 'none' },
    animation: 'none',
    homeSections: ['hero', 'services', 'team', 'faq', 'testimonials', 'cta'],
  },
  {
    id: 'market-row',
    name: 'Market Row',
    tagline: 'Product-forward, for shops with something to show.',
    industries: ['retail', 'restaurant'],
    tags: ['commerce', 'grid', 'light'],
    brand: kit({
      colors: {
        primary: '#111827', secondary: '#374151', accent: '#d97706',
        background: '#ffffff', surface: '#f9fafb', text: '#111827',
        textMuted: '#6b7280', border: '#e5e7eb',
      },
      type: {
        headingFamily: SANS_GROTESK, bodyFamily: SANS_SYSTEM, ratio: 1.25,
        baseSizePx: 16, headingWeight: 700, headingLineHeight: 1.15, letterSpacing: '-0.02em',
      },
      shape: CRISP,
      imageStyle: ['minimal', 'bright'],
    }),
    hero: { layout: 'centered', height: 'small', overlay: 'none' },
    animation: 'none',
    homeSections: ['hero', 'products', 'gallery', 'text_image', 'testimonials', 'cta'],
  },
  {
    id: 'lighthouse',
    name: 'Lighthouse',
    tagline: 'Community-minded and warm, for causes and member groups.',
    industries: ['nonprofit', 'education', 'events'],
    tags: ['friendly', 'rounded', 'light'],
    brand: kit({
      colors: {
        primary: '#1d4ed8', secondary: '#1e3a8a', accent: '#f59e0b',
        background: '#fffdf8', surface: '#fef6e7', text: '#15213b',
        textMuted: '#526080', border: '#efe2c8',
      },
      type: {
        headingFamily: SANS_GEO, bodyFamily: SANS_SYSTEM, ratio: 1.3,
        baseSizePx: 18, headingWeight: 700, headingLineHeight: 1.12, letterSpacing: '-0.015em',
      },
      shape: (b) => PILL(b, '29 78 216'),
      imageStyle: ['warm', 'documentary'],
    }),
    hero: { layout: 'split', height: 'medium', overlay: 'none' },
    animation: 'fade',
    homeSections: ['hero', 'stats', 'text_image', 'services', 'cta', 'testimonials'],
  },
  {
    id: 'atlas',
    name: 'Atlas',
    tagline: 'Corporate and dependable, for firms with a long client list.',
    industries: ['professional_services', 'education', 'generic'],
    tags: ['corporate', 'structured', 'light'],
    brand: kit({
      colors: {
        primary: '#1e40af', secondary: '#172554', accent: '#0891b2',
        background: '#ffffff', surface: '#f1f5f9', text: '#0f172a',
        textMuted: '#475569', border: '#dde3ea',
      },
      type: {
        headingFamily: SANS_SYSTEM, bodyFamily: SANS_SYSTEM, ratio: 1.24,
        baseSizePx: 16, headingWeight: 700, headingLineHeight: 1.18, letterSpacing: '-0.015em',
      },
      shape: (b) => SOFT(b, '30 64 175'),
      imageStyle: ['minimal', 'architectural'],
    }),
    hero: { layout: 'left', height: 'medium', overlay: 'none' },
    animation: 'none',
    homeSections: ['hero', 'services', 'logo_cloud', 'stats', 'testimonials', 'cta'],
  },
  {
    id: 'terminal',
    name: 'Terminal',
    tagline: 'Monospaced and deliberate, for people who like the machine visible.',
    industries: ['professional_services', 'generic'],
    tags: ['dark', 'mono', 'technical'],
    brand: kit({
      colors: {
        primary: '#4ade80', secondary: '#0a0f0c', accent: '#22d3ee',
        background: '#0a0f0c', surface: '#111a14', text: '#dcf5e4',
        textMuted: '#8fae9b', border: '#1e2b23',
      },
      type: {
        headingFamily: MONO, bodyFamily: MONO, ratio: 1.2,
        baseSizePx: 16, headingWeight: 700, lineHeight: 1.7, headingLineHeight: 1.2, letterSpacing: '-0.01em',
      },
      shape: SQUARE,
      imageStyle: ['minimal', 'documentary'],
    }),
    hero: { layout: 'left', height: 'medium', overlay: 'none' },
    animation: 'none',
    homeSections: ['hero', 'services', 'faq', 'stats', 'cta'],
  },
  {
    id: 'orchard',
    name: 'Orchard',
    tagline: 'Soft and seasonal, for makers and small-batch producers.',
    industries: ['retail', 'restaurant', 'hospitality'],
    tags: ['soft', 'natural', 'light'],
    brand: kit({
      colors: {
        primary: '#4d7c0f', secondary: '#3f6212', accent: '#db2777',
        background: '#fcfdf7', surface: '#f2f7e8', text: '#1f2911',
        textMuted: '#5c6a4a', border: '#dde6cc',
      },
      type: {
        headingFamily: SERIF_BOOK, bodyFamily: SANS_GEO, ratio: 1.3,
        baseSizePx: 18, headingWeight: 600, headingLineHeight: 1.14, letterSpacing: '-0.01em',
      },
      shape: (b) => PILL(b, '77 124 15'),
      imageStyle: ['natural', 'warm'],
    }),
    hero: { layout: 'split', height: 'medium', overlay: 'none' },
    animation: 'fade',
    homeSections: ['hero', 'text_image', 'products', 'gallery', 'testimonials', 'cta'],
  },
  {
    id: 'switchback',
    name: 'Switchback',
    tagline: 'Outdoor and hard-wearing, for work that happens in weather.',
    industries: ['trades', 'automotive', 'events'],
    tags: ['rugged', 'earthy', 'light'],
    brand: kit({
      colors: {
        primary: '#7c2d12', secondary: '#292524', accent: '#65a30d',
        background: '#faf9f7', surface: '#efece7', text: '#1c1917',
        textMuted: '#57534e', border: '#ddd8d0',
      },
      type: {
        headingFamily: SANS_GROTESK, bodyFamily: SANS_SYSTEM, ratio: 1.34,
        baseSizePx: 17, headingWeight: 800, headingLineHeight: 1.02, letterSpacing: '-0.03em',
      },
      shape: SQUARE,
      imageStyle: ['documentary', 'architectural'],
    }),
    hero: { layout: 'full_bleed', height: 'large', overlay: 'dark' },
    animation: 'slide-up',
    homeSections: ['hero', 'services', 'stats', 'gallery', 'testimonials', 'cta'],
  },
];

export function templateById(id: string): SiteTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * Templates ordered for a business in a given industry: designs built for that
 * trade first, everything else after. The whole library stays browsable — an
 * industry match is a good default, not a restriction on taste.
 */
export function templatesForIndustry(industry: IndustryKey): SiteTemplate[] {
  const matches = TEMPLATES.filter((t) => t.industries.includes(industry));
  const rest = TEMPLATES.filter((t) => !t.industries.includes(industry));
  return [...matches, ...rest];
}

export const ALL_TAGS = [...new Set(TEMPLATES.flatMap((t) => t.tags))].sort();
