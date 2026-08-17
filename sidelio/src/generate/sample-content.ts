/**
 * Sample content for design previews.
 *
 * A design gallery has a content problem before it has a design problem. The
 * generator correctly drops blocks it has no facts for — a stats band with no
 * stats is not a design choice, it is an empty element — so a template asking
 * for seven sections rendered as three, and every design looked sparse and
 * similar regardless of how different its system actually was.
 *
 * This module fills those gaps for previews only, so a design can be judged on
 * composition rather than on how little the crawler happened to find.
 *
 * The boundary is the important part:
 *
 *   - Sample content NEVER enters the page store, a ChangeSet, or the
 *     knowledge graph. `fillForPreview` returns a detached copy.
 *   - Every filled block is marked `sample: true` in its props so the preview
 *     can label it and no downstream code can mistake it for a fact.
 *   - Nothing here is attributed to the business. Testimonials are unnamed,
 *     statistics are generic, and imagery is abstract rather than fabricated
 *     photography of premises that may not look like this.
 *
 * That last rule matters: inventing "Sarah M., Halifax — best roofers in the
 * province" would be a fake review, and generating a photorealistic building
 * would be a fake picture of a real business. Neither belongs in a product
 * whose entire provenance model exists to stop exactly that.
 */

import type { Block, BlockType } from '../blocks/schema.ts';
import type { Page } from '../blocks/page.ts';
import type { BrandKit } from '../design/brand-kit.ts';

/* ------------------------------------------------------------------ */
/* Abstract imagery                                                    */
/* ------------------------------------------------------------------ */

/**
 * Deterministic abstract artwork in the design's own palette.
 *
 * Placeholder greys make every design look broken in the same way, which is
 * part of why sixteen designs read as one. Brand-coloured geometry shows the
 * palette doing work at image scale without pretending to be a photograph.
 */
export function sampleImage(kit: BrandKit, seed: number, ratio = 4 / 3): string {
  const w = 800;
  const h = Math.round(w / ratio);
  const { primary, accent, secondary, surface, background } = kit.colors;
  const a = accent ?? primary;
  const rnd = mulberry(seed * 2654435761);

  const shapes: string[] = [];
  const palette = [primary, a, secondary ?? primary];
  const pick = () => palette[Math.floor(rnd() * palette.length)] ?? primary;

  // A graded ground rather than a flat fill. A single flat colour behind a
  // hero is exactly the "solid rectangle" look that made two designs read as
  // broken rather than styled.
  const gid = `g${seed % 99991}`;
  const defs =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${pick()}" stop-opacity="0.55"/>` +
    `<stop offset="1" stop-color="${pick()}" stop-opacity="0.12"/>` +
    '</linearGradient></defs>';

  // Few and large reads as deliberate; many and small reads as noise. One
  // form is deliberately allowed to run off the edge so the composition
  // looks cropped from something bigger rather than centred in a box.
  for (let i = 0; i < 6; i++) {
    const fill = pick();
    const op = (0.16 + rnd() * 0.46).toFixed(2);
    const kind = Math.floor(rnd() * 4);
    if (kind === 0) {
      const r = Math.round(h * (0.24 + rnd() * 0.46));
      shapes.push(`<circle cx="${Math.round(rnd() * w)}" cy="${Math.round(rnd() * h)}" r="${r}" fill="${fill}" opacity="${op}"/>`);
    } else if (kind === 1) {
      const rw = Math.round(w * (0.24 + rnd() * 0.46));
      const rh = Math.round(h * (0.18 + rnd() * 0.52));
      shapes.push(`<rect x="${Math.round(rnd() * w - rw * 0.25)}" y="${Math.round(rnd() * h - rh * 0.25)}" width="${rw}" height="${rh}" fill="${fill}" opacity="${op}"/>`);
    } else if (kind === 2) {
      const x = Math.round(rnd() * w);
      const y = Math.round(rnd() * h);
      const s = Math.round(h * (0.36 + rnd() * 0.5));
      shapes.push(`<path d="M${x} ${y} l${s} 0 l${-Math.round(s / 2)} ${s} z" fill="${fill}" opacity="${op}"/>`);
    } else {
      // A hairline arc keeps the composition from being all mass.
      const r = Math.round(h * (0.3 + rnd() * 0.5));
      const cx = Math.round(rnd() * w);
      const cy = Math.round(rnd() * h);
      shapes.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${fill}" stroke-width="${Math.max(2, Math.round(h / 120))}" opacity="${(0.3 + rnd() * 0.4).toFixed(2)}"/>`);
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    defs +
    `<rect width="${w}" height="${h}" fill="${surface ?? background}"/>` +
    // Written raw: encodeURIComponent below turns `#` into %23. Pre-encoding
    // it here would produce %2523 and silently drop the gradient.
    `<rect width="${w}" height="${h}" fill="url(#${gid})"/>` +
    shapes.join('') +
    '</svg>';

  return `data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}`;
}

/** Small deterministic PRNG — previews must not change between renders. */
function mulberry(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Sample props                                                        */
/* ------------------------------------------------------------------ */

const SERVICES = [
  { name: 'Assessment', description: 'A full survey of the work needed, with photographs and a fixed written quote.' },
  { name: 'Installation', description: 'Carried out by our own crews to the manufacturer specification, never subcontracted.' },
  { name: 'Repair', description: 'Fast response for leaks and storm damage, with temporary cover the same day.' },
  { name: 'Maintenance', description: 'Scheduled inspections that catch small faults long before they become claims.' },
  { name: 'Emergency call-out', description: 'A number that reaches a person, twenty-four hours a day, all year.' },
  { name: 'Warranty service', description: 'Everything we fit is covered, and the cover stays with the building.' },
];

const STATS = [
  { value: '20+', label: 'Years in business' },
  { value: '4,000', label: 'Projects completed' },
  { value: '4.9', label: 'Average rating' },
  { value: '24h', label: 'Emergency response' },
];

/* Unattributed on purpose — see the note at the top of this file. */
const TESTIMONIALS = [
  { quote: 'They arrived when they said they would, finished a day early, and left the site cleaner than they found it.', author: 'Sample review', role: 'placeholder text', rating: 5 },
  { quote: 'The quote was the price. No extras appeared at the end, which is not something I can say about the last three trades I used.', author: 'Sample review', role: 'placeholder text', rating: 5 },
  { quote: 'Explained the options without pushing the expensive one. That is why they got the second job as well.', author: 'Sample review', role: 'placeholder text', rating: 4 },
];

const FAQ = [
  { question: 'How long does a typical job take?', answer: '<p>Most residential work is finished within two to four days, weather permitting. We confirm the schedule in writing before starting.</p>' },
  { question: 'Do you offer a warranty?', answer: '<p>Yes. Workmanship is guaranteed for ten years and materials carry the manufacturer warranty, both transferable if you sell.</p>' },
  { question: 'Are you insured?', answer: '<p>Fully insured and licensed. Certificates are provided with every quote without needing to ask.</p>' },
];

const TEAM = [
  { name: 'Team member', role: 'Founder' },
  { name: 'Team member', role: 'Site supervisor' },
  { name: 'Team member', role: 'Estimator' },
];

const PRICING = [
  { name: 'Inspection', price: 'Free', description: 'Survey, photographs and a written quote.', features: ['Full condition report', 'Fixed price quote', 'No obligation'] },
  { name: 'Repair', price: 'From $450', period: 'visit', description: 'Targeted fix with materials included.', features: ['Same-week booking', 'Materials included', '2 year guarantee'], highlighted: true },
  { name: 'Replacement', price: 'Quoted', description: 'Full replacement to specification.', features: ['Own crews', '10 year workmanship cover', 'Finance available'] },
];

/**
 * Props to substitute when a block of this type has nothing to render.
 * Returns undefined for block types that are legitimately empty.
 */
function sampleProps(type: BlockType, kit: BrandKit, seed: number): Record<string, unknown> | undefined {
  switch (type) {
    case 'services':
      return { heading: 'What we do', items: SERVICES.slice(0, 6), columns: 3 };
    case 'stats':
      return { items: STATS };
    case 'testimonials':
      return { heading: 'What clients say', items: TESTIMONIALS };
    case 'faq':
      return { heading: 'Common questions', items: FAQ };
    case 'team':
      return {
        heading: 'The people doing the work',
        members: TEAM.map((m, i) => ({ ...m, image: { url: sampleImage(kit, seed + i * 7, 1), alt: '' } })),
        columns: 3,
      };
    case 'pricing':
      return { heading: 'Straightforward pricing', tiers: PRICING };
    case 'gallery':
      return {
        heading: 'Recent work',
        columns: 3,
        images: Array.from({ length: 6 }, (_, i) => ({ url: sampleImage(kit, seed + i * 13), alt: '' })),
      };
    case 'logo_cloud':
      return {
        heading: 'Accredited by',
        grayscale: true,
        logos: Array.from({ length: 6 }, (_, i) => ({ url: sampleImage(kit, seed + i * 29, 3 / 2), alt: '' })),
      };
    default:
      return undefined;
  }
}

/** Does this block have enough content to render as anything? */
function isEmpty(block: Block): boolean {
  const p = block.props as Record<string, unknown>;
  const list = (k: string) => Array.isArray(p[k]) && (p[k] as unknown[]).length > 0;
  switch (block.type) {
    case 'services': return !list('items');
    case 'stats': return !list('items');
    case 'testimonials': return !list('items');
    case 'faq': return !list('items');
    case 'team': return !list('members');
    case 'pricing': return !list('tiers');
    case 'gallery': return !list('images');
    case 'logo_cloud': return !list('logos');
    default: return false;
  }
}

/* ------------------------------------------------------------------ */
/* Fill                                                                */
/* ------------------------------------------------------------------ */

export interface FillOptions {
  /** Sections the design intends to show, in order. */
  wantSections?: readonly BlockType[];
  /** Give hero and split media artwork when the site has no usable imagery. */
  fillImages?: boolean;
}

/**
 * Return a detached copy of `page` with empty blocks filled and missing
 * template sections appended, purely so a preview shows the design's real
 * composition. The input page is not modified and the result is never stored.
 */
export function fillForPreview(page: Page, kit: BrandKit, opts: FillOptions = {}): Page {
  const seedBase = hash(page.id);
  const blocks: Block[] = [];
  const present = new Set<BlockType>();

  for (const [i, block] of page.blocks.entries()) {
    present.add(block.type);
    if (!isEmpty(block)) {
      blocks.push(opts.fillImages ? withSampleMedia(block, kit, seedBase + i * 101) : block);
      continue;
    }
    const props = sampleProps(block.type, kit, seedBase + i * 31);
    if (!props) { blocks.push(block); continue; }
    blocks.push({ ...block, props: { ...block.props, ...props, sample: true } });
  }

  // A design that composes seven sections cannot be judged from the three the
  // crawler found data for.
  for (const type of opts.wantSections ?? []) {
    if (present.has(type)) continue;
    const props = sampleProps(type, kit, seedBase + hash(type));
    if (!props) continue;
    present.add(type);
    blocks.push(makeBlock(page.siteId, type, { ...props, sample: true }, blocks.length));
  }

  return { ...page, blocks };
}

/** Hero and inline media carry the design as much as type does. */
function withSampleMedia(block: Block, kit: BrandKit, seed: number): Block {
  const p = block.props as Record<string, unknown>;
  const hasUsable = (v: unknown) => {
    const img = v as { url?: string; assetId?: string } | undefined;
    return Boolean(img && (img.assetId || (img.url && img.url !== '')));
  };
  if (block.type === 'hero' && !hasUsable(p['image'])) {
    return { ...block, props: { ...p, image: { url: sampleImage(kit, seed, 16 / 9), alt: '' }, sample: true } };
  }
  if (block.type === 'text_image' && !hasUsable(p['image'])) {
    return { ...block, props: { ...p, image: { url: sampleImage(kit, seed, 4 / 3), alt: '' }, sample: true } };
  }
  return block;
}

function makeBlock(siteId: string, type: BlockType, props: Record<string, unknown>, order: number): Block {
  return {
    id: `blk_sample_${type}_${order}`,
    siteId,
    type,
    props,
    style: {
      scheme: 'inherit', align: 'left', animation: 'none',
      paddingTop: undefined, paddingBottom: undefined,
    },
    visibility: { hiddenOn: [] },
    order,
  } as unknown as Block;
}

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
