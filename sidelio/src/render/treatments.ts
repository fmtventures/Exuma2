/**
 * Visual treatments.
 *
 * A brand kit sets colour, type and spacing. A layout sets arrangement. Neither
 * gives a page *character* — that comes from treatments: the way media is
 * handled, how type behaves at display size, whether the ground has texture,
 * what moves when you scroll, what happens on hover.
 *
 * Without this layer the renderer produced correct, accessible, entirely inert
 * pages: no keyframes, no hover states, and `sl-anim-*` classes emitted onto
 * every block with no CSS behind them. Sixteen designs differing only in hue
 * read as one page recoloured, because that is what they were.
 *
 * Treatments are composable and opt-in per design. Only the chosen ones' CSS
 * ships. Everything here is pure CSS with no asset dependency — grain is an
 * inline SVG filter, duotone is a blend mode, scroll reveal is a scroll-driven
 * animation — so a published page still has no runtime and no network cost.
 *
 * Two rules everything here obeys:
 *
 *  1. A treatment may never hide content it cannot guarantee it will reveal.
 *     Reveal states are wrapped in `@supports (animation-timeline: view())`
 *     and unwound again under `prefers-reduced-motion`, because the base
 *     stylesheet kills all animation there and a stuck `opacity:0` would make
 *     the page permanently blank. They are unwound a second time for `print`,
 *     which is the case where the reveal never fires because nothing ever
 *     scrolls — measured on a real page, printing left two of three sections
 *     blank before this was added.
 *  2. A treatment may never reduce contrast below the audited value. Tints go
 *     behind media and decoration, never behind body text.
 */

export const TREATMENT_IDS = [
  // Motion
  'reveal', 'stagger', 'parallax', 'sticky-stack', 'mask-wipe', 'tilt',
  // Typography
  'display-tight', 'display-caps', 'drop-cap', 'numbered',
  'outline-type', 'italic-display', 'big-numerals',
  // Surface
  'grain', 'gradient-wash', 'hard-edge', 'ruled', 'dot-grid', 'stripes', 'glass',
  // Media
  'duotone', 'arch', 'offset-frame', 'polaroid', 'circle-mask',
  // Detail
  'marquee', 'underline', 'quote-marks', 'pull-quote', 'arrow-links', 'corner-marks',
] as const;

export type TreatmentId = (typeof TREATMENT_IDS)[number];

export type TreatmentCategory = 'motion' | 'type' | 'surface' | 'media' | 'detail';

export interface TreatmentDef {
  id: TreatmentId;
  name: string;
  category: TreatmentCategory;
  description: string;
  css: string;
}

/**
 * Applied whenever any treatment is active.
 *
 * Interaction feedback is not a decorative treatment — a link that does nothing
 * on hover is a defect — so it lives here rather than behind an opt-in.
 */
const BASE = `
.sl-tr a, .sl-tr .sl-btn { transition: color .18s ease, background-color .18s ease, border-color .18s ease, transform .18s ease, box-shadow .18s ease, opacity .18s ease; }
.sl-tr .sl-btn:hover { transform: translateY(-2px); box-shadow: var(--sl-shadow-md); }
.sl-tr .sl-btn--secondary:hover { background: var(--sl-color-primary); color: var(--sl-color-on-primary); }
.sl-tr .sl-card, .sl-tr .sl-person, .sl-tr .sl-tier, .sl-tr .sl-gallery__item img {
  transition: transform .25s ease, box-shadow .25s ease, border-color .25s ease;
}
.sl-tr .sl-card:hover, .sl-tr .sl-tier:hover { transform: translateY(-3px); box-shadow: var(--sl-shadow-md); }
.sl-tr .sl-gallery__item { overflow: hidden; border-radius: var(--sl-radius-md); }
.sl-tr .sl-gallery__item:hover img { transform: scale(1.04); }
@media (prefers-reduced-motion: reduce) {
  .sl-tr .sl-btn:hover, .sl-tr .sl-card:hover, .sl-tr .sl-tier:hover,
  .sl-tr .sl-gallery__item:hover img { transform: none; }
}
/* Nothing scrolls on paper, so any scroll-driven reveal prints blank. This is
   a blanket unwind rather than a per-treatment one: a section missing from a
   printed page is a worse failure than a lost effect, and the rule must hold
   for treatments added later without anyone remembering it.

   Deliberately scoped to elements and not to ::before/::after — generated
   content here is decoration held at low opacity on purpose (section
   numerals, quote marks, duotone overlays), and forcing those to full
   strength would stamp a solid colour block over every image. */
@media print {
  .sl-tr * {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
  }
  /* A fixed full-viewport texture would otherwise wash every printed page. */
  .sl-tr-grain::after { display: none !important; }
  .sl-tr .sl-block { break-inside: avoid; }
}
`;

/* Inline noise. feTurbulence at a high base frequency is indistinguishable from
   a grain plate at these opacities and costs no request. */
const GRAIN_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E\")";

export const TREATMENTS: Record<TreatmentId, TreatmentDef> = {
  /* ---------------------------------------------------------------- */
  /* Motion                                                            */
  /* ---------------------------------------------------------------- */

  reveal: {
    id: 'reveal',
    name: 'Scroll reveal',
    category: 'motion',
    description: 'Sections rise and fade as they enter the viewport.',
    css: `
@keyframes sl-rise { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: none; } }
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .sl-tr-reveal main > .sl-block {
      animation: sl-rise linear both;
      animation-timeline: view();
      animation-range: entry 0% entry 55%;
    }
    /* The first section is already in view on load; animating it produces a
       flash of empty page above the fold. */
    .sl-tr-reveal main > .sl-block:first-child { animation: none; }
  }
}
`,
  },

  stagger: {
    id: 'stagger',
    name: 'Staggered items',
    category: 'motion',
    description: 'Cards and grid items arrive one after another, not all at once.',
    css: `
@keyframes sl-rise-in { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .sl-tr-stagger .sl-grid > *, .sl-tr-stagger .sl-gallery > *,
    .sl-tr-stagger .sl-testimonials > *, .sl-tr-stagger .sl-pricing > * {
      animation: sl-rise-in linear both;
      animation-timeline: view();
      animation-range: entry 0% entry 40%;
    }
    /* A real stagger needs per-item offset; nth-child gives it without JS. */
    .sl-tr-stagger .sl-grid > *:nth-child(2), .sl-tr-stagger .sl-gallery > *:nth-child(2) { animation-range: entry 6% entry 46%; }
    .sl-tr-stagger .sl-grid > *:nth-child(3), .sl-tr-stagger .sl-gallery > *:nth-child(3) { animation-range: entry 12% entry 52%; }
    .sl-tr-stagger .sl-grid > *:nth-child(4), .sl-tr-stagger .sl-gallery > *:nth-child(4) { animation-range: entry 18% entry 58%; }
    .sl-tr-stagger .sl-grid > *:nth-child(n+5), .sl-tr-stagger .sl-gallery > *:nth-child(n+5) { animation-range: entry 24% entry 64%; }
  }
}
`,
  },

  parallax: {
    id: 'parallax',
    name: 'Hero drift',
    category: 'motion',
    description: 'Hero media drifts and settles behind the headline as you scroll.',
    css: `
@keyframes sl-drift { from { transform: scale(1.14) translateY(-3%); } to { transform: scale(1) translateY(3%); } }
.sl-tr-parallax .sl-block--hero { overflow: hidden; }
.sl-tr-parallax .sl-hero__image { will-change: transform; }
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .sl-tr-parallax .sl-hero__image {
      animation: sl-drift linear both;
      animation-timeline: view();
      animation-range: cover 0% cover 100%;
    }
  }
}
`,
  },

  /* ---------------------------------------------------------------- */
  /* Typography                                                        */
  /* ---------------------------------------------------------------- */

  'display-tight': {
    id: 'display-tight',
    name: 'Tight display type',
    category: 'type',
    description: 'Very large fluid headlines with negative tracking and a short measure.',
    css: `
/* Optical tracking: type set this large needs letterspacing pulled in, or it
   reads loose and amateur. The scale is fluid so it never overflows small
   screens. */
.sl-tr-display-tight .sl-hero__heading {
  font-size: clamp(2.75rem, 7.5vw, 6.5rem);
  letter-spacing: -0.035em;
  line-height: .96;
  max-width: 16ch;
  text-wrap: balance;
}
.sl-tr-display-tight .sl-heading, .sl-tr-display-tight h2 {
  font-size: clamp(1.9rem, 3.6vw, 3.25rem);
  letter-spacing: -0.025em;
  line-height: 1.04;
  max-width: 22ch;
  text-wrap: balance;
}
.sl-tr-display-tight .sl-hero__subheading { font-size: clamp(1.05rem, 1.6vw, 1.4rem); max-width: 48ch; }
.sl-tr-display-tight .sl-stat__value { font-size: clamp(2.4rem, 4.5vw, 4rem); letter-spacing: -0.03em; }
`,
  },

  'display-caps': {
    id: 'display-caps',
    name: 'Capitals and eyebrows',
    category: 'type',
    description: 'Uppercase headings with wide-tracked labels above each section.',
    css: `
.sl-tr-display-caps .sl-hero__heading, .sl-tr-display-caps .sl-heading,
.sl-tr-display-caps h2, .sl-tr-display-caps .sl-cta__heading {
  text-transform: uppercase;
  letter-spacing: 0.01em;
  line-height: 1.02;
}
.sl-tr-display-caps .sl-hero__heading { font-size: clamp(2.25rem, 6vw, 5rem); }
.sl-tr-display-caps .sl-eyebrow, .sl-tr-display-caps .sl-card__price,
.sl-tr-display-caps .sl-stat__label, .sl-tr-display-caps .sl-person__role {
  text-transform: uppercase;
  letter-spacing: 0.18em;
  font-size: .74rem;
  font-weight: 600;
  opacity: .75;
}
.sl-tr-display-caps .sl-eyebrow { margin-bottom: var(--sl-space-4); }
`,
  },

  'drop-cap': {
    id: 'drop-cap',
    name: 'Drop capitals',
    category: 'type',
    description: 'The opening paragraph of each section starts with a dropped initial.',
    css: `
/* initial-letter is the correct property and is now widely supported; the
   float fallback keeps the effect on engines that lack it. */
.sl-tr-drop-cap .sl-prose > p:first-of-type::first-letter {
  float: left;
  font-family: var(--sl-font-heading);
  font-size: 3.4em;
  line-height: .82;
  padding: .06em .1em 0 0;
  color: var(--sl-color-primary);
  font-weight: 700;
}
@supports (initial-letter: 3) {
  .sl-tr-drop-cap .sl-prose > p:first-of-type::first-letter {
    float: none; font-size: inherit; padding: 0; initial-letter: 3;
  }
}
.sl-tr-drop-cap .sl-hero__subheading::first-letter { font-size: inherit; float: none; }
`,
  },

  numbered: {
    id: 'numbered',
    name: 'Numbered sections',
    category: 'type',
    description: 'Each section carries an oversized index numeral in the margin.',
    css: `
.sl-tr-numbered main { counter-reset: sl-section; }
.sl-tr-numbered main > .sl-block:not(.sl-block--hero):not(.sl-block--banner) { counter-increment: sl-section; position: relative; }
.sl-tr-numbered main > .sl-block:not(.sl-block--hero):not(.sl-block--banner)::before {
  content: counter(sl-section, decimal-leading-zero);
  font-family: var(--sl-font-heading);
  font-size: clamp(3rem, 7vw, 6rem);
  font-weight: 700;
  line-height: 1;
  color: var(--sl-color-primary);
  opacity: .16;
  display: block;
  margin-bottom: var(--sl-space-3);
  /* Decorative: the number is not content, and a screen reader announcing
     "zero three" before every heading is noise. */
  speak: never;
}
@media (min-width: 1200px) {
  .sl-tr-numbered main > .sl-block:not(.sl-block--hero):not(.sl-block--banner)::before {
    position: absolute; left: -1.6em; top: var(--sl-space-8); margin: 0;
  }
}
`,
  },

  /* ---------------------------------------------------------------- */
  /* Surface                                                           */
  /* ---------------------------------------------------------------- */

  grain: {
    id: 'grain',
    name: 'Film grain',
    category: 'surface',
    description: 'A fine noise texture over the whole page, like printed stock.',
    css: `
.sl-tr-grain { position: relative; }
.sl-tr-grain::after {
  content: '';
  position: fixed;
  inset: 0;
  background-image: ${GRAIN_URI};
  opacity: .28;
  mix-blend-mode: multiply;
  pointer-events: none;
  z-index: 9999;
}
/* On a dark ground multiply would erase the grain; screen keeps it visible. */
.sl-tr-grain.sl-scheme-dark::after, .sl-tr-grain[data-dark]::after { mix-blend-mode: screen; opacity: .18; }
`,
  },

  'gradient-wash': {
    id: 'gradient-wash',
    name: 'Gradient wash',
    category: 'surface',
    description: 'Soft brand-coloured light pooling behind the hero and key sections.',
    css: `
.sl-tr-gradient-wash .sl-block--hero {
  position: relative;
  background-image:
    radial-gradient(120% 90% at 15% 0%, color-mix(in oklab, var(--sl-color-primary) 26%, transparent), transparent 62%),
    radial-gradient(90% 80% at 92% 18%, color-mix(in oklab, var(--sl-color-accent, var(--sl-color-primary)) 22%, transparent), transparent 58%);
}
.sl-tr-gradient-wash .sl-block--cta {
  background-image: linear-gradient(135deg,
    color-mix(in oklab, var(--sl-color-primary) 16%, transparent),
    color-mix(in oklab, var(--sl-color-primary) 3%, transparent));
}
/* color-mix is the clean way to tint without a second palette; where it is
   unsupported the section simply keeps its flat ground. */
@supports not (color: color-mix(in oklab, red 50%, blue)) {
  .sl-tr-gradient-wash .sl-block--hero { background-image: none; }
}
`,
  },

  'hard-edge': {
    id: 'hard-edge',
    name: 'Hard edge',
    category: 'surface',
    description: 'Thick black rules, square corners and offset blocks instead of soft shadows.',
    css: `
.sl-tr-hard-edge .sl-card, .sl-tr-hard-edge .sl-person, .sl-tr-hard-edge .sl-tier,
.sl-tr-hard-edge .sl-testimonial, .sl-tr-hard-edge .sl-btn {
  border-radius: 0;
  border: 2px solid var(--sl-color-text);
  box-shadow: 5px 5px 0 var(--sl-color-text);
}
.sl-tr-hard-edge .sl-btn--primary { border-color: var(--sl-color-text); }
.sl-tr-hard-edge .sl-card:hover, .sl-tr-hard-edge .sl-tier:hover,
.sl-tr-hard-edge .sl-btn:hover {
  transform: translate(2px, 2px);
  box-shadow: 2px 2px 0 var(--sl-color-text);
}
.sl-tr-hard-edge .sl-image, .sl-tr-hard-edge .sl-gallery__item,
.sl-tr-hard-edge .sl-gallery__item img { border-radius: 0; }
.sl-tr-hard-edge .sl-heading, .sl-tr-hard-edge h2 {
  border-bottom: 3px solid var(--sl-color-text);
  padding-bottom: var(--sl-space-3);
}
@media (prefers-reduced-motion: reduce) {
  .sl-tr-hard-edge .sl-card:hover, .sl-tr-hard-edge .sl-tier:hover, .sl-tr-hard-edge .sl-btn:hover { transform: none; }
}
`,
  },

  ruled: {
    id: 'ruled',
    name: 'Ruled grid',
    category: 'surface',
    description: 'Hairline rules between every section and column, like a spec sheet.',
    css: `
.sl-tr-ruled main > .sl-block + .sl-block { border-top: 1px solid var(--sl-color-border); }
.sl-tr-ruled .sl-grid { gap: 0; }
.sl-tr-ruled .sl-grid > * {
  border-right: 1px solid var(--sl-color-border);
  border-bottom: 1px solid var(--sl-color-border);
  padding: var(--sl-space-6);
  background: transparent;
  box-shadow: none;
  border-radius: 0;
  border-top: 0; border-left: 0;
}
.sl-tr-ruled .sl-heading, .sl-tr-ruled h2 {
  font-size: var(--sl-text-h4);
  text-transform: uppercase;
  letter-spacing: .12em;
  opacity: .7;
}
.sl-tr-ruled .sl-stats { gap: 0; }
.sl-tr-ruled .sl-stat { padding-right: var(--sl-space-7); border-right: 1px solid var(--sl-color-border); }
`,
  },

  /* ---------------------------------------------------------------- */
  /* Media                                                             */
  /* ---------------------------------------------------------------- */

  duotone: {
    id: 'duotone',
    name: 'Duotone',
    category: 'media',
    description: 'Photography is flattened to two brand colours.',
    css: `
/* A blend-based duotone tracks the brand palette automatically, where a
   baked filter chain would need re-tuning for every hue. */
.sl-tr-duotone .sl-hero__image, .sl-tr-duotone .sl-gallery__item,
.sl-tr-duotone .sl-split__media, .sl-tr-duotone .sl-person__photo { position: relative; }
.sl-tr-duotone .sl-hero__image, .sl-tr-duotone .sl-gallery__item img,
.sl-tr-duotone .sl-split__media img, .sl-tr-duotone .sl-person__photo {
  filter: grayscale(1) contrast(1.12);
}
/* The tint element must wrap the image and nothing else. These two do. */
.sl-tr-duotone .sl-gallery__item::after, .sl-tr-duotone .sl-split__media::after {
  content: '';
  position: absolute; inset: 0;
  background: var(--sl-color-primary);
  mix-blend-mode: color;
  pointer-events: none;
}
/* The hero deliberately gets no overlay element. A hero has no wrapper around
   its image alone, so tinting it with a full-bleed ::after blends over the
   entire section — headline, buttons and ground included — and the whole page
   comes out washed in one hue. Measured: it turned a warm neutral hero into a
   flat sheet of peach. The image carries its own treatment instead. */
.sl-tr-duotone .sl-hero__image { filter: grayscale(1) contrast(1.15) brightness(.96); }
/* Restoring colour on hover makes the gallery feel alive rather than dead. */
.sl-tr-duotone .sl-gallery__item:hover img { filter: none; }
.sl-tr-duotone .sl-gallery__item:hover::after { opacity: 0; transition: opacity .25s ease; }
`,
  },

  arch: {
    id: 'arch',
    name: 'Arched media',
    category: 'media',
    description: 'Images are masked into tall arches and soft capsules.',
    css: `
.sl-tr-arch .sl-split__media img, .sl-tr-arch .sl-gallery__item img {
  border-radius: 999px 999px var(--sl-radius-md) var(--sl-radius-md);
  aspect-ratio: 3 / 4;
  object-fit: cover;
  width: 100%;
}
.sl-tr-arch .sl-gallery__item { overflow: visible; }
.sl-tr-arch .sl-gallery__item:nth-child(even) img { border-radius: var(--sl-radius-md) var(--sl-radius-md) 999px 999px; }
.sl-tr-arch .sl-person__photo { border-radius: 999px 999px var(--sl-radius-md) var(--sl-radius-md); aspect-ratio: 3 / 4; }
.sl-tr-arch .sl-hero__image { border-radius: 0; }
`,
  },

  'offset-frame': {
    id: 'offset-frame',
    name: 'Offset frame',
    category: 'media',
    description: 'A block of colour sits behind and offset from every image.',
    css: `
.sl-tr-offset-frame .sl-split__media { position: relative; }
.sl-tr-offset-frame .sl-split__media::before {
  content: '';
  position: absolute;
  inset: var(--sl-space-5) calc(var(--sl-space-5) * -1) calc(var(--sl-space-5) * -1) var(--sl-space-5);
  background: var(--sl-color-primary);
  border-radius: var(--sl-radius-lg);
  z-index: 0;
}
.sl-tr-offset-frame .sl-split__media img { position: relative; z-index: 1; border-radius: var(--sl-radius-lg); }
.sl-tr-offset-frame .sl-gallery__item img { border-radius: var(--sl-radius-lg); }
`,
  },

  /* ---------------------------------------------------------------- */
  /* Detail                                                            */
  /* ---------------------------------------------------------------- */

  marquee: {
    id: 'marquee',
    name: 'Marquee strip',
    category: 'detail',
    description: 'Logos scroll continuously in a horizontal band.',
    css: `
@keyframes sl-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.sl-tr-marquee .sl-block--logo_cloud { overflow: hidden; }
.sl-tr-marquee .sl-logos {
  flex-wrap: nowrap;
  width: max-content;
  animation: sl-marquee 32s linear infinite;
}
.sl-tr-marquee .sl-block--logo_cloud:hover .sl-logos { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) {
  /* Continuous motion is a vestibular trigger, and it is not decorative here
     — it is the only thing that reveals the far end of the list. Fall back to
     a scrollable row rather than a truncated one. */
  .sl-tr-marquee .sl-logos { animation: none; width: auto; overflow-x: auto; }
  .sl-tr-marquee .sl-block--logo_cloud { overflow: visible; }
}
`,
  },

  underline: {
    id: 'underline',
    name: 'Drawn underlines',
    category: 'detail',
    description: 'Links draw an underline from left to right on hover.',
    css: `
.sl-tr-underline .sl-prose a, .sl-tr-underline .sl-card__title a, .sl-tr-underline nav a {
  text-decoration: none;
  background-image: linear-gradient(var(--sl-color-primary), var(--sl-color-primary));
  background-repeat: no-repeat;
  background-position: 0 100%;
  background-size: 0% 2px;
  transition: background-size .28s ease;
  padding-bottom: 2px;
}
.sl-tr-underline .sl-prose a:hover, .sl-tr-underline .sl-card__title a:hover, .sl-tr-underline nav a:hover {
  background-size: 100% 2px;
}
/* Removing the underline entirely would fail 1.4.1 for anyone who cannot
   perceive the link colour, so keyboard focus and reduced motion both restore
   a real one. */
.sl-tr-underline .sl-prose a:focus-visible, .sl-tr-underline nav a:focus-visible { text-decoration: underline; }
@media (prefers-reduced-motion: reduce) {
  .sl-tr-underline .sl-prose a, .sl-tr-underline .sl-card__title a, .sl-tr-underline nav a {
    background-size: 100% 1px;
  }
}
`,
  },

  'quote-marks': {
    id: 'quote-marks',
    name: 'Display quotes',
    category: 'detail',
    description: 'Oversized quotation marks anchor every testimonial.',
    css: `
.sl-tr-quote-marks .sl-testimonial { position: relative; padding-top: var(--sl-space-8); }
.sl-tr-quote-marks .sl-testimonial::before {
  content: '\\201C';
  position: absolute;
  top: calc(var(--sl-space-3) * -1);
  left: var(--sl-space-4);
  font-family: var(--sl-font-heading);
  font-size: 5.5rem;
  line-height: 1;
  color: var(--sl-color-primary);
  opacity: .22;
  pointer-events: none;
}
.sl-tr-quote-marks .sl-testimonial blockquote { position: relative; font-style: italic; }
.sl-tr-quote-marks .sl-testimonial figcaption { margin-top: var(--sl-space-4); font-weight: 600; opacity: .8; }
`,
  },

  /* ---------------------------------------------------------------- */
  /* Motion — second set                                               */
  /* ---------------------------------------------------------------- */

  'sticky-stack': {
    id: 'sticky-stack',
    name: 'Stacking panels',
    category: 'motion',
    description: 'Sections pin at the top and the next one slides over them.',
    css: `
/* Each section must paint its own ground, or the pinned one shows through the
   one sliding over it and both become unreadable. */
.sl-tr-sticky-stack main > .sl-block {
  position: sticky; top: 0;
  background: var(--sl-color-background);
  border-top: var(--sl-border-width) solid var(--sl-color-border);
}
.sl-tr-sticky-stack main > .sl-block:nth-child(even) { background: var(--sl-color-surface); }
.sl-tr-sticky-stack main > .sl-block:last-child { position: static; }
@media (max-width: 900px) {
  /* Pinning on a short viewport hides more than it reveals. */
  .sl-tr-sticky-stack main > .sl-block { position: static; }
}
`,
  },

  'mask-wipe': {
    id: 'mask-wipe',
    name: 'Wipe reveal',
    category: 'motion',
    description: 'Headings and media are wiped into view rather than faded.',
    css: `
@keyframes sl-wipe { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .sl-tr-mask-wipe .sl-heading, .sl-tr-mask-wipe main > .sl-block > h2,
    .sl-tr-mask-wipe .sl-gallery__item img, .sl-tr-mask-wipe .sl-split__media img {
      animation: sl-wipe linear both;
      animation-timeline: view();
      animation-range: entry 5% entry 50%;
    }
  }
}
`,
  },

  tilt: {
    id: 'tilt',
    name: 'Tilt on hover',
    category: 'motion',
    description: 'Cards lift and tilt slightly under the pointer.',
    css: `
.sl-tr-tilt .sl-card, .sl-tr-tilt .sl-tier, .sl-tr-tilt .sl-person, .sl-tr-tilt .sl-testimonial {
  transition: transform .3s cubic-bezier(.2,.8,.3,1), box-shadow .3s ease;
  transform-origin: center bottom;
}
.sl-tr-tilt .sl-card:hover, .sl-tr-tilt .sl-tier:hover,
.sl-tr-tilt .sl-person:hover, .sl-tr-tilt .sl-testimonial:hover {
  transform: perspective(900px) rotateX(3deg) translateY(-6px) scale(1.015);
  box-shadow: var(--sl-shadow-lg);
}
@media (prefers-reduced-motion: reduce) {
  .sl-tr-tilt .sl-card:hover, .sl-tr-tilt .sl-tier:hover,
  .sl-tr-tilt .sl-person:hover, .sl-tr-tilt .sl-testimonial:hover { transform: none; }
}
`,
  },

  /* ---------------------------------------------------------------- */
  /* Typography — second set                                           */
  /* ---------------------------------------------------------------- */

  'outline-type': {
    id: 'outline-type',
    name: 'Outlined display',
    category: 'type',
    description: 'The headline is drawn as a hollow outline and fills on hover.',
    css: `
.sl-tr-outline-type .sl-hero__heading {
  font-size: clamp(2.5rem, 7vw, 6rem);
  letter-spacing: -0.03em;
  line-height: .98;
  color: transparent;
  -webkit-text-stroke: 2px var(--sl-color-text);
  paint-order: stroke fill;
}
/* text-stroke is prefixed everywhere it exists; where it does not, the
   heading must not stay transparent and disappear. */
@supports not (-webkit-text-stroke: 1px red) {
  .sl-tr-outline-type .sl-hero__heading { color: var(--sl-color-text); }
}
.sl-tr-outline-type .sl-heading, .sl-tr-outline-type main > .sl-block > h2 {
  font-size: clamp(1.8rem, 3.4vw, 3rem);
  letter-spacing: -0.02em;
}
.sl-tr-outline-type .sl-stat__value {
  color: transparent;
  -webkit-text-stroke: 1.5px var(--sl-color-primary);
  font-size: clamp(2.2rem, 4vw, 3.6rem);
}
@supports not (-webkit-text-stroke: 1px red) {
  .sl-tr-outline-type .sl-stat__value { color: var(--sl-color-primary); }
}
`,
  },

  'italic-display': {
    id: 'italic-display',
    name: 'Italic display',
    category: 'type',
    description: 'Large italic headlines with a high-contrast roman body.',
    css: `
.sl-tr-italic-display .sl-hero__heading {
  font-style: italic;
  font-size: clamp(2.6rem, 6.5vw, 5.5rem);
  line-height: 1.02;
  letter-spacing: -0.02em;
  max-width: 15ch;
  text-wrap: balance;
}
.sl-tr-italic-display .sl-heading, .sl-tr-italic-display main > .sl-block > h2 {
  font-style: italic;
  font-size: clamp(1.7rem, 3.2vw, 2.8rem);
  letter-spacing: -0.015em;
}
.sl-tr-italic-display .sl-eyebrow {
  font-style: normal;
  text-transform: uppercase;
  letter-spacing: .2em;
  font-size: .72rem;
}
.sl-tr-italic-display .sl-hero__subheading { font-size: clamp(1.05rem, 1.5vw, 1.3rem); max-width: 46ch; }
`,
  },

  'big-numerals': {
    id: 'big-numerals',
    name: 'Enormous figures',
    category: 'type',
    description: 'Statistics are set at headline scale and carry the section.',
    css: `
.sl-tr-big-numerals .sl-stats {
  gap: var(--sl-space-9);
  align-items: end;
}
.sl-tr-big-numerals .sl-stat__value {
  font-size: clamp(3rem, 8vw, 7rem);
  line-height: .88;
  letter-spacing: -0.045em;
  font-weight: 800;
  color: var(--sl-color-primary);
}
.sl-tr-big-numerals .sl-stat__label {
  text-transform: uppercase;
  letter-spacing: .14em;
  font-size: .74rem;
  margin-top: var(--sl-space-3);
  max-width: 16ch;
}
.sl-tr-big-numerals .sl-tier__price { font-size: clamp(2rem, 3.4vw, 3rem); letter-spacing: -0.03em; }
`,
  },

  /* ---------------------------------------------------------------- */
  /* Surface — second set                                              */
  /* ---------------------------------------------------------------- */

  'dot-grid': {
    id: 'dot-grid',
    name: 'Dot grid',
    category: 'surface',
    description: 'A faint engineering dot grid runs behind the whole page.',
    css: `
/* Drawn with a gradient rather than an image: no request, and it re-tints
   automatically when the palette changes. */
.sl-tr-dot-grid {
  background-image: radial-gradient(var(--sl-color-border) 1px, transparent 1px);
  background-size: 24px 24px;
  background-attachment: fixed;
}
.sl-tr-dot-grid main > .sl-block { background: transparent; }
.sl-tr-dot-grid .sl-card, .sl-tr-dot-grid .sl-tier, .sl-tr-dot-grid .sl-person,
.sl-tr-dot-grid .sl-testimonial { background: var(--sl-color-background); }
.sl-tr-dot-grid .sl-block--hero { background: transparent; }
`,
  },

  stripes: {
    id: 'stripes',
    name: 'Diagonal bands',
    category: 'surface',
    description: 'Angled colour bands cut across section edges.',
    css: `
.sl-tr-stripes main > .sl-block { position: relative; }
.sl-tr-stripes main > .sl-block:nth-child(odd)::before {
  content: '';
  position: absolute; inset: 0;
  background: repeating-linear-gradient(
    135deg,
    color-mix(in oklab, var(--sl-color-primary) 9%, transparent) 0 14px,
    transparent 14px 34px);
  pointer-events: none;
}
@supports not (color: color-mix(in oklab, red 50%, blue)) {
  .sl-tr-stripes main > .sl-block:nth-child(odd)::before { background: none; }
}
.sl-tr-stripes .sl-block--cta {
  border-top: 6px solid var(--sl-color-primary);
  border-bottom: 6px solid var(--sl-color-primary);
}
.sl-tr-stripes .sl-heading, .sl-tr-stripes main > .sl-block > h2 {
  position: relative;
  padding-left: var(--sl-space-5);
}
.sl-tr-stripes .sl-heading::before, .sl-tr-stripes main > .sl-block > h2::before {
  content: '';
  position: absolute; left: 0; top: .1em; bottom: .1em;
  width: 5px; background: var(--sl-color-primary);
}
`,
  },

  glass: {
    id: 'glass',
    name: 'Frosted panels',
    category: 'surface',
    description: 'Cards float as translucent frosted panels over the ground.',
    css: `
.sl-tr-glass .sl-card, .sl-tr-glass .sl-tier, .sl-tr-glass .sl-person, .sl-tr-glass .sl-testimonial {
  background: color-mix(in oklab, var(--sl-color-background) 62%, transparent);
  border: 1px solid color-mix(in oklab, var(--sl-color-text) 12%, transparent);
  backdrop-filter: blur(14px) saturate(1.25);
  box-shadow: 0 12px 40px rgb(0 0 0 / .10);
}
/* Frost is a luxury: without color-mix or backdrop-filter the panel must still
   be an opaque, readable surface rather than a transparent smear. */
@supports not (backdrop-filter: blur(4px)) {
  .sl-tr-glass .sl-card, .sl-tr-glass .sl-tier,
  .sl-tr-glass .sl-person, .sl-tr-glass .sl-testimonial { background: var(--sl-color-surface); }
}
@supports not (color: color-mix(in oklab, red 50%, blue)) {
  .sl-tr-glass .sl-card, .sl-tr-glass .sl-tier,
  .sl-tr-glass .sl-person, .sl-tr-glass .sl-testimonial {
    background: var(--sl-color-surface); border-color: var(--sl-color-border);
  }
}
.sl-tr-glass .sl-block--hero .sl-hero__content { border-radius: var(--sl-radius-lg); }
`,
  },

  /* ---------------------------------------------------------------- */
  /* Media — second set                                                */
  /* ---------------------------------------------------------------- */

  polaroid: {
    id: 'polaroid',
    name: 'Print frames',
    category: 'media',
    description: 'Photographs sit in white mounts, tilted like prints on a desk.',
    css: `
.sl-tr-polaroid .sl-gallery__item {
  background: #fff;
  padding: 10px 10px 34px;
  box-shadow: 0 6px 22px rgb(0 0 0 / .16);
  border-radius: 2px;
  overflow: visible;
}
.sl-tr-polaroid .sl-gallery__item img { border-radius: 0; aspect-ratio: 1; object-fit: cover; width: 100%; }
.sl-tr-polaroid .sl-gallery { gap: var(--sl-space-7); }
/* Alternating rotation, so a grid of prints does not look like a grid. */
.sl-tr-polaroid .sl-gallery__item:nth-child(3n+1) { transform: rotate(-1.6deg); }
.sl-tr-polaroid .sl-gallery__item:nth-child(3n+2) { transform: rotate(1.1deg); }
.sl-tr-polaroid .sl-gallery__item:nth-child(3n) { transform: rotate(-.5deg); }
.sl-tr-polaroid .sl-gallery__item:hover { transform: rotate(0) scale(1.03); z-index: 2; }
.sl-tr-polaroid .sl-split__media img { background: #fff; padding: 12px; box-shadow: 0 8px 26px rgb(0 0 0 / .16); }
@media (prefers-reduced-motion: reduce) {
  .sl-tr-polaroid .sl-gallery__item:hover { transform: none; }
}
`,
  },

  'circle-mask': {
    id: 'circle-mask',
    name: 'Circular media',
    category: 'media',
    description: 'Images are cropped to circles and soft organic shapes.',
    css: `
.sl-tr-circle-mask .sl-gallery__item img {
  border-radius: 50%;
  aspect-ratio: 1;
  object-fit: cover;
  width: 100%;
}
.sl-tr-circle-mask .sl-gallery__item { overflow: visible; }
.sl-tr-circle-mask .sl-split__media img {
  border-radius: 46% 54% 58% 42% / 52% 44% 56% 48%;
  aspect-ratio: 1;
  object-fit: cover;
  width: 100%;
}
.sl-tr-circle-mask .sl-person__photo { border-radius: 50%; aspect-ratio: 1; object-fit: cover; }
.sl-tr-circle-mask .sl-gallery { gap: var(--sl-space-7); }
`,
  },

  /* ---------------------------------------------------------------- */
  /* Detail — second set                                               */
  /* ---------------------------------------------------------------- */

  'pull-quote': {
    id: 'pull-quote',
    name: 'Pull quotes',
    category: 'detail',
    description: 'A line of body copy is lifted out large between the columns.',
    css: `
/* The first blockquote inside prose becomes a display pull quote — the same
   markup an author already writes, given editorial weight. */
.sl-tr-pull-quote .sl-prose blockquote {
  font-family: var(--sl-font-heading);
  font-size: clamp(1.35rem, 2.6vw, 2.1rem);
  line-height: 1.18;
  letter-spacing: -0.015em;
  margin: var(--sl-space-7) 0;
  padding-left: var(--sl-space-6);
  border-left: 4px solid var(--sl-color-primary);
  color: var(--sl-color-text);
  max-width: 26ch;
}
.sl-tr-pull-quote .sl-intro {
  font-size: clamp(1.1rem, 1.8vw, 1.45rem);
  max-width: 44ch;
  color: var(--sl-color-text);
}
.sl-tr-pull-quote .sl-testimonial blockquote { font-size: var(--sl-text-body-lg); border: 0; padding: 0; max-width: none; }
`,
  },

  'arrow-links': {
    id: 'arrow-links',
    name: 'Arrow links',
    category: 'detail',
    description: 'Buttons and card titles grow an arrow that slides on hover.',
    css: `
.sl-tr-arrow-links .sl-btn--secondary::after,
.sl-tr-arrow-links .sl-card__title a::after {
  content: '\\2192';
  display: inline-block;
  margin-left: .5em;
  transition: transform .22s ease;
}
.sl-tr-arrow-links .sl-btn--secondary:hover::after,
.sl-tr-arrow-links .sl-card__title a:hover::after { transform: translateX(5px); }
.sl-tr-arrow-links .sl-card { display: flex; flex-direction: column; }
.sl-tr-arrow-links .sl-card__title a { text-decoration: none; }
.sl-tr-arrow-links .sl-card:hover { border-color: var(--sl-color-primary); }
@media (prefers-reduced-motion: reduce) {
  .sl-tr-arrow-links .sl-btn--secondary:hover::after,
  .sl-tr-arrow-links .sl-card__title a:hover::after { transform: none; }
}
`,
  },

  'corner-marks': {
    id: 'corner-marks',
    name: 'Corner marks',
    category: 'detail',
    description: 'Printer crop marks bracket each section, like a proof sheet.',
    css: `
.sl-tr-corner-marks main > .sl-block { position: relative; }
.sl-tr-corner-marks main > .sl-block::before,
.sl-tr-corner-marks main > .sl-block::after {
  content: '';
  position: absolute;
  width: 16px; height: 16px;
  border: 2px solid var(--sl-color-primary);
  opacity: .6;
  pointer-events: none;
}
.sl-tr-corner-marks main > .sl-block::before {
  top: 14px; left: 14px; border-right: 0; border-bottom: 0;
}
.sl-tr-corner-marks main > .sl-block::after {
  bottom: 14px; right: 14px; border-left: 0; border-top: 0;
}
.sl-tr-corner-marks .sl-heading, .sl-tr-corner-marks main > .sl-block > h2 {
  text-transform: uppercase;
  letter-spacing: .16em;
  font-size: var(--sl-text-h4);
}
`,
  },
};

/** Body classes for a treatment set. */
export function treatmentClasses(ids: readonly string[]): string {
  const valid = ids.filter((id): id is TreatmentId => id in TREATMENTS);
  if (valid.length === 0) return '';
  return `sl-tr ${valid.map((id) => `sl-tr-${id}`).join(' ')}`;
}

/** Only the chosen treatments' CSS ships — the rest is never sent. */
export function treatmentCss(ids: readonly string[]): string {
  const valid = ids.filter((id): id is TreatmentId => id in TREATMENTS);
  if (valid.length === 0) return '';
  return BASE + valid.map((id) => TREATMENTS[id].css).join('');
}

export const TREATMENT_LIST = TREATMENT_IDS.map((id) => ({
  id,
  name: TREATMENTS[id].name,
  category: TREATMENTS[id].category,
  description: TREATMENTS[id].description,
}));

export function treatmentsByCategory(category: TreatmentCategory): TreatmentDef[] {
  return TREATMENT_IDS.map((id) => TREATMENTS[id]).filter((t) => t.category === category);
}
