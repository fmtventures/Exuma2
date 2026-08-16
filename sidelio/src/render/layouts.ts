/**
 * Page layouts.
 *
 * A design system decides how things *look*; a layout decides how the page is
 * *arranged*. The template library previously varied only the former, so
 * sixteen designs all rendered as full-width sections stacked in a centred
 * container — the same page recoloured.
 *
 * A layout changes the structural frame every block sits in: the measure, the
 * rhythm between sections, whether there is a persistent column, whether
 * sections alternate, bleed, overlap or sit as cards. Blocks are unchanged —
 * that is the point of keeping them as data. The same block tree renders into
 * any of these.
 *
 * Each layout is plain CSS scoped under a body class, so it costs nothing at
 * runtime and degrades to the stacked default if a class is unknown.
 */

export const LAYOUT_IDS = [
  'stack', 'sidebar', 'split', 'editorial', 'canvas',
  'offset', 'cards', 'magazine', 'showcase', 'compact',
  'masonry', 'banded', 'rail',
] as const;

export type LayoutId = (typeof LAYOUT_IDS)[number];

export interface LayoutDef {
  id: LayoutId;
  name: string;
  /** One line describing the arrangement, shown in the gallery. */
  description: string;
  css: string;
}

/** Shared skeleton every layout builds on. */
const BASE = `
.sl-layout { --sl-measure: 1200px; }
.sl-layout .sl-block { max-width: var(--sl-block-max-width, var(--sl-measure)); margin-inline: auto; }
`;

export const LAYOUTS: Record<LayoutId, LayoutDef> = {
  stack: {
    id: 'stack',
    name: 'Stacked',
    description: 'Classic full-width sections, one after another, centred measure.',
    css: `
.sl-stack { --sl-measure: 1180px; }
.sl-stack .sl-block { padding-block: var(--sl-space-9); }
.sl-stack .sl-block--hero { padding-block: var(--sl-space-11); }
`,
  },

  sidebar: {
    id: 'sidebar',
    name: 'Sidebar',
    description: 'A persistent left column holds identity and contact; content runs beside it.',
    css: `
.sl-sidebar { --sl-measure: 100%; }
@media (min-width: 1000px) {
  .sl-sidebar main {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    align-items: start;
    max-width: 1400px; margin-inline: auto;
  }
  /* The hero becomes the fixed column: identity stays on screen while the
     rest of the page scrolls past it. */
  .sl-sidebar .sl-block--hero {
    position: sticky; top: 0;
    height: 100vh; display: flex; flex-direction: column; justify-content: center;
    padding: var(--sl-space-8);
    background: var(--sl-color-surface);
    border-right: var(--sl-border-width) solid var(--sl-color-border);
    margin: 0; max-width: none;
  }
  .sl-sidebar .sl-block--hero .sl-hero__heading { font-size: var(--sl-text-h2); }
  .sl-sidebar .sl-block:not(.sl-block--hero) {
    grid-column: 2; max-width: 760px; margin: 0;
    padding: var(--sl-space-8) var(--sl-space-8);
  }
  .sl-sidebar .sl-grid { grid-template-columns: repeat(2, 1fr); }
}
`,
  },

  split: {
    id: 'split',
    name: 'Split',
    description: 'Every other section divides the screen in half, alternating side to side.',
    css: `
.sl-split-layout { --sl-measure: 100%; }
.sl-split-layout .sl-block { padding: 0; max-width: none; }
@media (min-width: 900px) {
  .sl-split-layout .sl-block {
    display: grid; grid-template-columns: 1fr 1fr; align-items: center; min-height: 68vh;
  }
  /* A section with nothing to put in the second half should not reserve one —
     an empty column reads as a broken page, not a deliberate one. */
  .sl-split-layout .sl-block:not(:has(> * + *)) { grid-template-columns: 1fr; min-height: 42vh; }
  .sl-split-layout .sl-block:not(:has(> * + *)) > * { max-width: 720px; }
  /* Alternate which half carries the tint, so the eye zig-zags down. */
  .sl-split-layout .sl-block > * { padding: var(--sl-space-9) var(--sl-space-8); }
  .sl-split-layout .sl-block:nth-child(odd) { background: var(--sl-color-background); }
  .sl-split-layout .sl-block:nth-child(even) { background: var(--sl-color-surface); }
  .sl-split-layout .sl-block:nth-child(even) > * { order: 2; }
  .sl-split-layout .sl-block--hero { min-height: 100vh; }
  .sl-split-layout .sl-grid { grid-template-columns: 1fr; gap: var(--sl-space-5); }
}
@media (max-width: 899px) {
  .sl-split-layout .sl-block > * { padding: var(--sl-space-7) var(--sl-space-5); }
}
`,
  },

  editorial: {
    id: 'editorial',
    name: 'Editorial',
    description: 'A narrow reading measure with images and galleries breaking out wider.',
    css: `
.sl-editorial { --sl-measure: 680px; }
.sl-editorial .sl-block { padding-block: var(--sl-space-8); }
/* Text holds a book-like measure; media escapes it. */
.sl-editorial .sl-block--gallery,
.sl-editorial .sl-block--logo_cloud,
.sl-editorial .sl-block--stats { max-width: 1100px; }
.sl-editorial .sl-block--hero { max-width: 900px; padding-block: var(--sl-space-10); }
.sl-editorial .sl-prose { font-size: var(--sl-text-body-lg); }
.sl-editorial .sl-block--text_image .sl-split { grid-template-columns: 1fr; }
.sl-editorial .sl-block + .sl-block { border-top: var(--sl-border-width) solid var(--sl-color-border); }
`,
  },

  canvas: {
    id: 'canvas',
    name: 'Canvas',
    description: 'Edge-to-edge sections with no container, alternating full-bleed grounds.',
    css: `
.sl-canvas { --sl-measure: 100%; }
.sl-canvas .sl-block { max-width: none; padding: var(--sl-space-10) var(--sl-space-7); }
.sl-canvas .sl-block > * { max-width: 1240px; margin-inline: auto; }
/* Bands of alternating ground make the page read as slabs, not a column. */
.sl-canvas .sl-block:nth-of-type(even) { background: var(--sl-color-surface); }
.sl-canvas .sl-block--hero {
  min-height: 92vh; display: flex; align-items: center;
  padding-block: var(--sl-space-11);
}
.sl-canvas .sl-grid { gap: var(--sl-space-8); }
`,
  },

  offset: {
    id: 'offset',
    name: 'Offset',
    description: 'An asymmetric grid: content sits two thirds across, headings hang left.',
    css: `
.sl-offset { --sl-measure: 1240px; }
@media (min-width: 900px) {
  .sl-offset .sl-block {
    display: grid; grid-template-columns: 1fr 2fr; gap: var(--sl-space-8);
    padding-block: var(--sl-space-9);
    align-items: start;
  }
  /* The section heading hangs in the narrow left column, everything else
     occupies the wide one — a deliberate, repeated asymmetry. */
  .sl-offset .sl-block > .sl-heading,
  .sl-offset .sl-block > h2 { grid-column: 1; margin: 0; position: sticky; top: var(--sl-space-6); }
  .sl-offset .sl-block > *:not(.sl-heading):not(h2) { grid-column: 2; }
  .sl-offset .sl-block--hero { grid-template-columns: 1fr; }
  .sl-offset .sl-grid { grid-template-columns: repeat(2, 1fr); }
}
`,
  },

  cards: {
    id: 'cards',
    name: 'Cards',
    description: 'Each section is a raised card floating on a tinted ground.',
    css: `
.sl-cards { background: var(--sl-color-surface); --sl-measure: 1120px; }
.sl-cards main { padding-block: var(--sl-space-7); }
.sl-cards .sl-block {
  background: var(--sl-color-background);
  border: var(--sl-border-width) solid var(--sl-color-border);
  border-radius: var(--sl-radius-lg);
  box-shadow: var(--sl-shadow-md);
  padding: var(--sl-space-8);
  margin-block: var(--sl-space-6);
}
.sl-cards .sl-block--hero {
  padding: var(--sl-space-10) var(--sl-space-8);
  box-shadow: var(--sl-shadow-lg);
}
/* Cards already carry a border; nesting more chrome inside reads as noise. */
.sl-cards .sl-card, .sl-cards .sl-person, .sl-cards .sl-testimonial {
  box-shadow: none; background: var(--sl-color-surface);
}
`,
  },

  magazine: {
    id: 'magazine',
    name: 'Magazine',
    description: 'Dense multi-column text with tight rhythm and rules between sections.',
    css: `
.sl-magazine { --sl-measure: 1160px; }
.sl-magazine .sl-block { padding-block: var(--sl-space-7); }
.sl-magazine .sl-block + .sl-block {
  border-top: 2px solid var(--sl-color-text);
}
@media (min-width: 800px) {
  /* Real columns, not a grid of cards — body copy flows between them. */
  .sl-magazine .sl-prose { columns: 2; column-gap: var(--sl-space-8); }
  .sl-magazine .sl-block--hero .sl-prose { columns: 1; }
  .sl-magazine .sl-grid { grid-template-columns: repeat(4, 1fr); gap: var(--sl-space-5); }
  .sl-magazine .sl-testimonials { grid-template-columns: repeat(3, 1fr); }
}
.sl-magazine .sl-block--hero { padding-block: var(--sl-space-8) var(--sl-space-9); }
.sl-magazine .sl-hero__heading { font-size: var(--sl-text-display); }
`,
  },

  showcase: {
    id: 'showcase',
    name: 'Showcase',
    description: 'Oversized media and long pauses between very few elements.',
    css: `
.sl-showcase { --sl-measure: 1320px; }
.sl-showcase .sl-block { padding-block: var(--sl-space-12, 96px); }
.sl-showcase .sl-block--hero {
  min-height: 100vh; display: flex; align-items: flex-end;
  padding-bottom: var(--sl-space-10);
}
.sl-showcase .sl-hero__heading { font-size: var(--sl-text-display); max-width: 14ch; }
/* One thing at a time, very large. */
.sl-showcase .sl-grid { grid-template-columns: 1fr; gap: var(--sl-space-10); }
.sl-showcase .sl-gallery { grid-template-columns: 1fr; }
.sl-showcase .sl-gallery img, .sl-showcase .sl-split__media img { width: 100%; }
.sl-showcase .sl-heading, .sl-showcase h2 { font-size: var(--sl-text-h1); max-width: 18ch; }
`,
  },

  compact: {
    id: 'compact',
    name: 'Compact',
    description: 'Tight and information-dense — as much above the fold as possible.',
    css: `
.sl-compact { --sl-measure: 1080px; }
.sl-compact .sl-block { padding-block: var(--sl-space-6); }
.sl-compact .sl-block--hero { padding-block: var(--sl-space-7); }
.sl-compact .sl-hero__heading { font-size: var(--sl-text-h2); }
.sl-compact .sl-heading, .sl-compact h2 { font-size: var(--sl-text-h4); margin-bottom: var(--sl-space-3); }
.sl-compact .sl-grid { gap: var(--sl-space-4); grid-template-columns: repeat(4, 1fr); }
.sl-compact .sl-card, .sl-compact .sl-person, .sl-compact .sl-testimonial { padding: var(--sl-space-4); }
.sl-compact .sl-buttons { margin-top: var(--sl-space-4); }
@media (max-width: 900px) { .sl-compact .sl-grid { grid-template-columns: repeat(2, 1fr); } }
`,
  },

  masonry: {
    id: 'masonry',
    name: 'Masonry',
    description: 'Uneven columns of differing height, packed rather than aligned.',
    css: `
.sl-masonry { --sl-measure: 1240px; }
.sl-masonry .sl-block { padding-block: var(--sl-space-8); }
@media (min-width: 900px) {
  /* Real column packing, not a grid — items flow and the run-on is uneven,
     which is the whole point of a masonry wall. */
  .sl-masonry .sl-grid, .sl-masonry .sl-gallery {
    display: block;
    columns: 3;
    column-gap: var(--sl-space-6);
  }
  .sl-masonry .sl-grid > *, .sl-masonry .sl-gallery > * {
    break-inside: avoid;
    margin-bottom: var(--sl-space-6);
    display: block;
  }
  /* Varying the media ratio is what makes the columns pack unevenly; equal
     tiles in columns just look like a grid with a bug. */
  .sl-masonry .sl-gallery__item:nth-child(3n+1) img { aspect-ratio: 3 / 4; object-fit: cover; width: 100%; }
  .sl-masonry .sl-gallery__item:nth-child(3n+2) img { aspect-ratio: 1; object-fit: cover; width: 100%; }
  .sl-masonry .sl-gallery__item:nth-child(3n) img { aspect-ratio: 4 / 3; object-fit: cover; width: 100%; }
  .sl-masonry .sl-testimonials { columns: 2; column-gap: var(--sl-space-6); display: block; }
  .sl-masonry .sl-testimonials > * { break-inside: avoid; margin-bottom: var(--sl-space-6); }
}
.sl-masonry .sl-block--hero { padding-block: var(--sl-space-10); }
`,
  },

  banded: {
    id: 'banded',
    name: 'Banded',
    description: 'Alternating full-width bands of light and dark, edge to edge.',
    css: `
.sl-banded { --sl-measure: 100%; }
.sl-banded .sl-block { max-width: none; padding: var(--sl-space-10) var(--sl-space-7); }
.sl-banded .sl-block > * { max-width: 1180px; margin-inline: auto; }
/* Every other band inverts. The scheme swap has to carry the text colour with
   it or the band below reads as a contrast failure rather than a design. */
.sl-banded main > .sl-block:nth-child(4n+3) {
  background: var(--sl-color-text);
  color: var(--sl-color-background);
  --sl-color-text: var(--sl-color-background);
  --sl-color-border: color-mix(in oklab, var(--sl-color-background) 28%, transparent);
}
.sl-banded main > .sl-block:nth-child(4n+3) .sl-card,
.sl-banded main > .sl-block:nth-child(4n+3) .sl-tier,
.sl-banded main > .sl-block:nth-child(4n+3) .sl-testimonial {
  background: transparent;
  border-color: var(--sl-color-border);
}
.sl-banded main > .sl-block:nth-child(4n+1) { background: var(--sl-color-surface); }
.sl-banded .sl-block--hero { min-height: 80vh; display: flex; align-items: center; }
`,
  },

  rail: {
    id: 'rail',
    name: 'Rail',
    description: 'Content on the left with a narrow contents rail pinned right.',
    css: `
.sl-rail { --sl-measure: 100%; }
@media (min-width: 1100px) {
  .sl-rail main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 240px;
    gap: var(--sl-space-9);
    max-width: 1320px;
    margin-inline: auto;
    padding-inline: var(--sl-space-6);
    align-items: start;
  }
  .sl-rail main > .sl-block { grid-column: 1; max-width: 780px; margin: 0; padding-block: var(--sl-space-8); }
  /* The contact block becomes the rail: the thing a visitor needs at any
     point on the page is the thing that should never scroll away. */
  .sl-rail main > .sl-block--contact,
  .sl-rail main > .sl-block--cta {
    grid-column: 2;
    grid-row: 2 / span 99;
    position: sticky;
    top: var(--sl-space-6);
    max-width: none;
    padding: var(--sl-space-6);
    background: var(--sl-color-surface);
    border: var(--sl-border-width) solid var(--sl-color-border);
    border-radius: var(--sl-radius-lg);
  }
  .sl-rail main > .sl-block--hero { grid-column: 1 / -1; max-width: none; }
  .sl-rail .sl-grid { grid-template-columns: repeat(2, 1fr); }
  .sl-rail .sl-cta__heading { font-size: var(--sl-text-h4); }
  .sl-rail .sl-buttons { flex-direction: column; align-items: stretch; }
}
`,
  },
};

export function layoutById(id: string | undefined): LayoutDef {
  return LAYOUTS[(id ?? 'stack') as LayoutId] ?? LAYOUTS.stack;
}

/** Body class applied for a layout. `split` is suffixed to avoid clashing
 *  with the existing `.sl-split` block-level helper. */
export function layoutClass(id: LayoutId): string {
  return `sl-layout sl-${id === 'split' ? 'split-layout' : id}`;
}

/** Only the chosen layout's CSS ships — the rest is not sent to the browser. */
export function layoutCss(id: LayoutId): string {
  return `${BASE}${layoutById(id).css}`;
}

export const LAYOUT_LIST = LAYOUT_IDS.map((id) => ({
  id,
  name: LAYOUTS[id].name,
  description: LAYOUTS[id].description,
}));
