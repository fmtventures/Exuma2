/**
 * Brand kit and design tokens.
 *
 * One central definition per site drives every rendered surface. Blocks never
 * hard-code a colour or a size — they reference a token — so "use our brand
 * green" is a single-value change that propagates everywhere, and an agency
 * can lock the kit against client edits without locking the content.
 */

export interface ColorScale {
  /** 50..900 ramp generated from the base colour. */
  [step: string]: string;
}

export interface BrandColors {
  primary: string;
  secondary?: string;
  accent?: string;
  neutral: string;
  /** Semantic roles resolved by the renderer. */
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
  success: string;
  warning: string;
  danger: string;
}

export interface TypographyScale {
  headingFamily: string;
  bodyFamily: string;
  /** Modular scale ratio — 1.2 (minor third) through 1.5 (perfect fifth). */
  ratio: number;
  baseSizePx: number;
  headingWeight: number;
  bodyWeight: number;
  lineHeight: number;
  headingLineHeight: number;
  letterSpacing: string;
}

export interface SpacingScale {
  baseUnitPx: number;
  /** Multipliers, e.g. [0, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16]. */
  steps: number[];
}

export interface ShapeTokens {
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  radiusFull: string;
  borderWidth: string;
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
}

export type ImageStyleAttribute =
  | 'cinematic' | 'bright' | 'minimal' | 'warm' | 'editorial'
  | 'architectural' | 'luxury' | 'playful' | 'documentary' | 'natural';

export interface BrandKit {
  logoAssetId?: string;
  altLogoAssetId?: string;
  faviconAssetId?: string;
  colors: BrandColors;
  typography: TypographyScale;
  spacing: SpacingScale;
  shape: ShapeTokens;
  /**
   * Descriptive attributes, never a named artist. These feed AI Media Studio
   * prompts so generated imagery matches the site without imitating anyone's
   * personal style.
   */
  imageStyle: ImageStyleAttribute[];
  voice?: string;
  /** Token names an agency has locked against client edits. */
  lockedTokens: string[];
}

export const DEFAULT_BRAND_KIT: BrandKit = {
  colors: {
    primary: '#2563eb',
    secondary: '#0f172a',
    accent: '#f59e0b',
    neutral: '#64748b',
    background: '#ffffff',
    surface: '#f8fafc',
    text: '#0f172a',
    textMuted: '#475569',
    border: '#e2e8f0',
    success: '#16a34a',
    warning: '#d97706',
    danger: '#dc2626',
  },
  typography: {
    headingFamily: 'Inter, system-ui, sans-serif',
    bodyFamily: 'Inter, system-ui, sans-serif',
    ratio: 1.25,
    baseSizePx: 16,
    headingWeight: 700,
    bodyWeight: 400,
    lineHeight: 1.6,
    headingLineHeight: 1.15,
    letterSpacing: '-0.011em',
  },
  spacing: { baseUnitPx: 4, steps: [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64] },
  shape: {
    radiusSm: '4px', radiusMd: '8px', radiusLg: '16px', radiusFull: '9999px',
    borderWidth: '1px',
    shadowSm: '0 1px 2px rgb(15 23 42 / 0.06)',
    shadowMd: '0 4px 12px rgb(15 23 42 / 0.08)',
    shadowLg: '0 12px 32px rgb(15 23 42 / 0.12)',
  },
  imageStyle: ['bright', 'natural'],
  lockedTokens: [],
};

/** Type scale sizes, largest heading first. */
export function typeScale(t: TypographyScale): Record<string, string> {
  const s = (step: number) => `${(t.baseSizePx * t.ratio ** step) / 16}rem`;
  return {
    'display': s(5),
    'h1': s(4),
    'h2': s(3),
    'h3': s(2),
    'h4': s(1),
    'body-lg': s(0.5),
    'body': s(0),
    'small': s(-1),
    'caption': s(-2),
  };
}

/* ------------------------------------------------------------------ */
/* Colour utilities                                                    */
/* ------------------------------------------------------------------ */

export interface Rgb { r: number; g: number; b: number }

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let body = m[1] as string;
  if (body.length === 3) body = body.split('').map((c) => c + c).join('');
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((c) => clamp(c).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return 1;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type WcagLevel = 'AAA' | 'AA' | 'AA-large' | 'fail';

export function wcagLevel(ratio: number): WcagLevel {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA-large';
  return 'fail';
}

/**
 * Pick black or white text for a background — used everywhere a brand colour
 * becomes a button or a section fill, so accessibility survives a colour change.
 */
export function readableTextOn(background: string): string {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#0f172a')
    ? '#ffffff'
    : '#0f172a';
}

function mix(a: Rgb, b: Rgb, weight: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * weight,
    g: a.g + (b.g - a.g) * weight,
    b: a.b + (b.b - a.b) * weight,
  };
}

/** Generate a 50..900 ramp from a base colour. */
export function generateScale(baseHex: string): ColorScale {
  const base = hexToRgb(baseHex);
  if (!base) return {};
  const white: Rgb = { r: 255, g: 255, b: 255 };
  const black: Rgb = { r: 15, g: 23, b: 42 };
  const stops: Array<[string, number]> = [
    ['50', 0.95], ['100', 0.88], ['200', 0.74], ['300', 0.56], ['400', 0.3],
    ['500', 0], ['600', -0.16], ['700', -0.32], ['800', -0.48], ['900', -0.64],
  ];
  const scale: ColorScale = {};
  for (const [step, weight] of stops) {
    scale[step] = weight >= 0
      ? rgbToHex(mix(base, white, weight))
      : rgbToHex(mix(base, black, -weight));
  }
  return scale;
}

export interface ContrastIssue {
  token: string;
  foreground: string;
  background: string;
  ratio: number;
  level: WcagLevel;
  /**
   * `text` pairs are judged against WCAG 1.4.3 (4.5:1). `ui` pairs — a button
   * fill against the page behind it, a border against its surface — are judged
   * against WCAG 1.4.11 non-text contrast (3:1). Without the second check a
   * near-white primary passes on label readability while being an invisible
   * button on a white page.
   */
  kind: 'text' | 'ui';
}

const UI_CONTRAST_MINIMUM = 3;

/**
 * Audit a brand kit's colour pairings. Runs whenever a colour changes, so an
 * AI or user edit that breaks readability is caught before publish rather
 * than by a visitor.
 */
export function auditContrast(kit: BrandKit): ContrastIssue[] {
  const c = kit.colors;
  const issues: ContrastIssue[] = [];

  const textPairs: Array<[string, string, string]> = [
    ['text on background', c.text, c.background],
    ['muted text on background', c.textMuted, c.background],
    ['text on surface', c.text, c.surface],
    ['primary button label', readableTextOn(c.primary), c.primary],
    ['danger button label', readableTextOn(c.danger), c.danger],
    ['success button label', readableTextOn(c.success), c.success],
    ['link on background', c.primary, c.background],
  ];
  for (const [token, fg, bg] of textPairs) {
    const ratio = contrastRatio(fg, bg);
    const level = wcagLevel(ratio);
    if (level === 'fail' || level === 'AA-large') {
      issues.push({ token, foreground: fg, background: bg, ratio: round(ratio), level, kind: 'text' });
    }
  }

  // Non-text contrast: the component must be distinguishable from what is
  // behind it, independent of whether its label is legible.
  const uiPairs: Array<[string, string, string]> = [
    ['primary button against page background', c.primary, c.background],
    ['primary button against surface', c.primary, c.surface],
  ];
  for (const [token, fg, bg] of uiPairs) {
    const ratio = contrastRatio(fg, bg);
    if (ratio < UI_CONTRAST_MINIMUM) {
      issues.push({ token, foreground: fg, background: bg, ratio: round(ratio), level: 'fail', kind: 'ui' });
    }
  }

  return issues;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Font stacks offered in the admin.
 *
 * System and open-source families only, declared as full CSS stacks. A
 * published Sidelio site must not depend on a font CDN — that is a third-party
 * request on every page load, a privacy exposure, and a single point of
 * failure for the site's typography. Anything not installed falls through the
 * stack to a sane local face.
 */
export const FONT_STACKS: Array<{ id: string; label: string; stack: string; kind: 'sans' | 'serif' | 'mono' }> = [
  { id: 'system-sans', label: 'System sans', kind: 'sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'inter', label: 'Inter', kind: 'sans', stack: 'Inter, system-ui, sans-serif' },
  { id: 'helvetica', label: 'Helvetica / Arial', kind: 'sans', stack: 'Helvetica Neue, Helvetica, Arial, sans-serif' },
  { id: 'avenir', label: 'Avenir / Nunito', kind: 'sans', stack: 'Avenir Next, Avenir, Nunito Sans, system-ui, sans-serif' },
  { id: 'system-serif', label: 'System serif', kind: 'serif', stack: 'Georgia, Cambria, "Times New Roman", serif' },
  { id: 'iowan', label: 'Iowan / Palatino', kind: 'serif', stack: 'Iowan Old Style, Palatino Linotype, Palatino, serif' },
  { id: 'charter', label: 'Charter / Bitstream', kind: 'serif', stack: 'Charter, Bitstream Charter, Georgia, serif' },
  { id: 'mono', label: 'Monospace', kind: 'mono', stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
];

export interface TypographyIssue {
  field: string;
  message: string;
  severity: 'blocking' | 'warning';
}

/**
 * Validate a typography change. Body text below 14px and cramped leading are
 * the two settings that most reliably make a site unreadable, so they are
 * refused rather than warned about.
 */
export function auditTypography(t: TypographyScale): TypographyIssue[] {
  const issues: TypographyIssue[] = [];

  if (t.baseSizePx < 14) {
    issues.push({ field: 'baseSizePx', severity: 'blocking', message: `Body text at ${t.baseSizePx}px is too small to read comfortably. 16px is the recommended minimum.` });
  } else if (t.baseSizePx < 16) {
    issues.push({ field: 'baseSizePx', severity: 'warning', message: `${t.baseSizePx}px body text is below the 16px most readers expect.` });
  }
  if (t.baseSizePx > 24) {
    issues.push({ field: 'baseSizePx', severity: 'warning', message: `${t.baseSizePx}px body text is unusually large and will wrap awkwardly on mobile.` });
  }
  if (t.lineHeight < 1.3) {
    issues.push({ field: 'lineHeight', severity: 'blocking', message: `A line height of ${t.lineHeight} crowds the text. WCAG asks for at least 1.5 in body copy.` });
  } else if (t.lineHeight < 1.5) {
    issues.push({ field: 'lineHeight', severity: 'warning', message: `WCAG 1.4.12 asks for a body line height of at least 1.5; this is ${t.lineHeight}.` });
  }
  if (t.ratio < 1.05) {
    issues.push({ field: 'ratio', severity: 'warning', message: 'A scale ratio this small leaves headings nearly the same size as body text.' });
  }
  if (t.ratio > 1.8) {
    issues.push({ field: 'ratio', severity: 'warning', message: 'A scale ratio this large makes display headings overwhelm the page on mobile.' });
  }
  if (t.headingWeight < 400) {
    issues.push({ field: 'headingWeight', severity: 'warning', message: 'Headings lighter than 400 lose their hierarchy against body text.' });
  }
  return issues;
}

/** Emit the kit as CSS custom properties consumed by the renderer. */
export function toCssVariables(kit: BrandKit): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(kit.colors)) {
    lines.push(`  --sl-color-${kebab(name)}: ${value};`);
  }
  const primaryScale = generateScale(kit.colors.primary);
  for (const [step, value] of Object.entries(primaryScale)) {
    lines.push(`  --sl-color-primary-${step}: ${value};`);
  }
  lines.push(`  --sl-color-on-primary: ${readableTextOn(kit.colors.primary)};`);

  for (const [name, size] of Object.entries(typeScale(kit.typography))) {
    lines.push(`  --sl-text-${name}: ${size};`);
  }
  lines.push(`  --sl-font-heading: ${kit.typography.headingFamily};`);
  lines.push(`  --sl-font-body: ${kit.typography.bodyFamily};`);
  lines.push(`  --sl-line-height: ${kit.typography.lineHeight};`);
  lines.push(`  --sl-line-height-heading: ${kit.typography.headingLineHeight};`);
  lines.push(`  --sl-letter-spacing: ${kit.typography.letterSpacing};`);

  kit.spacing.steps.forEach((step, i) => {
    lines.push(`  --sl-space-${i}: ${step * kit.spacing.baseUnitPx}px;`);
  });
  for (const [name, value] of Object.entries(kit.shape)) {
    lines.push(`  --sl-${kebab(name)}: ${value};`);
  }
  return `:root {\n${lines.join('\n')}\n}`;
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
