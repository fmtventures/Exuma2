import type { BrandKit } from '../design/brand-kit.ts';
import type { BlockType } from '../blocks/schema.ts';

/**
 * Design concept themes.
 *
 * A "concept" is a design direction, not a hero height. Earlier this varied
 * only layout flags while all three directions shared one brand kit, which
 * produced three identical pages — the picker looked like a feature and was
 * doing nothing. A direction now carries its own palette, type pairing, shape
 * language, spacing rhythm and section composition, because those are the
 * things that actually make two designs feel different.
 *
 * The palettes are derived from the subject rather than pulled from a generic
 * set: this is a trades business, so the directions draw on materials and
 * site-safety colour — slate and shingle tones, weathered copper, hi-vis
 * amber — instead of the default SaaS blue.
 */

export type ConceptDirection = 'conservative' | 'modern' | 'bold';

export interface ConceptTheme {
  direction: ConceptDirection;
  /** One line explaining who this direction suits, shown in the picker. */
  rationale: string;
  brand: (base: BrandKit) => BrandKit;
  hero: {
    layout: 'centered' | 'left' | 'split' | 'full_bleed';
    height: 'small' | 'medium' | 'large' | 'viewport';
    overlay: 'none' | 'dark' | 'light' | 'gradient';
  };
  animation: 'none' | 'fade' | 'slide-up' | 'zoom';
  /** Section order for the home page — the structural half of the difference. */
  homeSections: BlockType[];
  /** Sections appended to every interior page. */
  interiorTail: BlockType[];
}

const SERIF = 'Iowan Old Style, Palatino Linotype, Palatino, Georgia, serif';
const GEOMETRIC = 'Avenir Next, Avenir, Nunito Sans, system-ui, sans-serif';
const GROTESK = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const SYSTEM = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const CONCEPT_THEMES: Record<ConceptDirection, ConceptTheme> = {
  /**
   * Established and reassuring. Slate blue and warm stone, serif headings,
   * square corners, no shadow — the visual language of a firm that has been
   * on the Island since 1998 and wants that read immediately. Proof comes
   * early: stats and testimonials sit above the fold-and-a-half.
   */
  conservative: {
    direction: 'conservative',
    rationale: 'Established and trust-led. Reads as a firm with decades behind it.',
    brand: (base) => ({
      ...base,
      colors: {
        ...base.colors,
        primary: '#1f3a5f',      // deep slate blue
        secondary: '#2f3e46',
        accent: '#8a6f48',       // weathered brass
        background: '#ffffff',
        surface: '#f4f2ee',      // warm stone, not a cool grey
        text: '#1c232b',
        textMuted: '#54606c',
        border: '#dcd8d0',
      },
      typography: {
        ...base.typography,
        headingFamily: SERIF,
        bodyFamily: SYSTEM,
        ratio: 1.2,
        baseSizePx: 17,
        headingWeight: 700,
        lineHeight: 1.65,
        headingLineHeight: 1.2,
        letterSpacing: '0',
      },
      shape: {
        ...base.shape,
        radiusSm: '2px', radiusMd: '3px', radiusLg: '4px',
        shadowSm: 'none',
        shadowMd: '0 1px 0 rgb(28 35 43 / 0.08)',
        shadowLg: '0 2px 0 rgb(28 35 43 / 0.10)',
      },
      imageStyle: ['documentary', 'natural'],
    }),
    hero: { layout: 'left', height: 'medium', overlay: 'light' },
    animation: 'none',
    homeSections: ['hero', 'stats', 'services', 'testimonials', 'text_image', 'cta'],
    interiorTail: ['cta'],
  },

  /**
   * Current and approachable. Teal-slate with a clean geometric sans, generous
   * radius and soft shadows, a split hero and more air between sections. The
   * default a small business would pick today without looking generic.
   */
  modern: {
    direction: 'modern',
    rationale: 'Clean and current. Generous spacing, soft edges, easy to scan on a phone.',
    brand: (base) => ({
      ...base,
      colors: {
        ...base.colors,
        primary: '#0f766e',      // deep teal
        secondary: '#134e4a',
        accent: '#f59e0b',
        background: '#ffffff',
        surface: '#f0fdfa',
        text: '#111f22',
        textMuted: '#4b5f63',
        border: '#d5e7e4',
      },
      typography: {
        ...base.typography,
        headingFamily: GEOMETRIC,
        bodyFamily: GEOMETRIC,
        ratio: 1.28,
        baseSizePx: 17,
        headingWeight: 700,
        lineHeight: 1.7,
        headingLineHeight: 1.15,
        letterSpacing: '-0.015em',
      },
      shape: {
        ...base.shape,
        radiusSm: '8px', radiusMd: '14px', radiusLg: '24px',
        shadowSm: '0 1px 3px rgb(15 118 110 / 0.08)',
        shadowMd: '0 8px 24px rgb(15 118 110 / 0.10)',
        shadowLg: '0 20px 48px rgb(15 118 110 / 0.14)',
      },
      imageStyle: ['bright', 'natural'],
    }),
    hero: { layout: 'split', height: 'large', overlay: 'none' },
    animation: 'fade',
    homeSections: ['hero', 'services', 'text_image', 'stats', 'testimonials', 'gallery', 'cta'],
    interiorTail: ['cta'],
  },

  /**
   * Loud and immediate. Near-black ground with hi-vis amber — the colour
   * already on the crew's vests and the site signage — plus a heavy grotesk at
   * a large scale, square corners and a full-bleed viewport hero. Built to be
   * remembered from a truck door, not admired at a desk.
   */
  bold: {
    direction: 'bold',
    rationale: 'Loud and memorable. High-contrast, large type, made to be recognised.',
    brand: (base) => ({
      ...base,
      colors: {
        ...base.colors,
        primary: '#f59f00',      // hi-vis amber
        secondary: '#111315',
        accent: '#ff6b35',
        background: '#111315',   // dark ground, deliberately
        surface: '#1c1f22',
        text: '#f5f3f0',
        textMuted: '#b3b8bd',
        border: '#32383d',
      },
      typography: {
        ...base.typography,
        headingFamily: GROTESK,
        bodyFamily: SYSTEM,
        ratio: 1.42,             // a much wider gap between heading and body
        baseSizePx: 18,
        headingWeight: 800,
        lineHeight: 1.55,
        headingLineHeight: 0.98,
        letterSpacing: '-0.03em',
      },
      shape: {
        ...base.shape,
        radiusSm: '0', radiusMd: '0', radiusLg: '0', radiusFull: '0',
        borderWidth: '2px',
        shadowSm: 'none', shadowMd: 'none', shadowLg: 'none',
      },
      imageStyle: ['cinematic', 'architectural'],
    }),
    // No overlay: the ground is already near-black, so an overlay only dulls
    // the type. A hero photograph reads fine against it as-is.
    hero: { layout: 'full_bleed', height: 'viewport', overlay: 'none' },
    animation: 'slide-up',
    homeSections: ['hero', 'services', 'gallery', 'stats', 'cta', 'testimonials'],
    interiorTail: ['cta'],
  },
};

/**
 * Per-block scheme.
 *
 * Always `inherit`. The renderer's `.sl-scheme-dark` rule *inverts* the token
 * set to make one section dark inside an otherwise light site — so applying it
 * to a kit whose ground is already dark inverts twice and paints dark text on
 * a dark background. A direction expresses its darkness in its palette; the
 * per-block flag stays available for a single contrasting section.
 */
export function schemeFor(_direction: ConceptDirection): 'light' | 'dark' | 'inherit' {
  return 'inherit';
}

export function themeFor(direction: ConceptDirection): ConceptTheme {
  return CONCEPT_THEMES[direction];
}
