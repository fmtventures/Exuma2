import type { Page } from '../blocks/page.ts';
import { isVisibleAt, resolveResponsive, type Block, type Breakpoint } from '../blocks/schema.ts';
import { readableTextOn, toCssVariables, type BrandKit } from '../design/brand-kit.ts';
import type { Asset } from '../media/asset.ts';
import { responsiveImage } from '../media/studio.ts';

/**
 * Block renderer.
 *
 * Produces semantic, accessible HTML from the block tree. Deliberately
 * string-based and dependency-free: the output must be renderable in a Node
 * worker for static publishing, in an edge function for dynamic pages, and in
 * the editor's preview iframe, without dragging a framework runtime into any
 * of them.
 *
 * Accessibility and SEO are not post-processing steps here — headings come out
 * in order, images always carry an alt attribute, interactive elements are real
 * buttons and links, and structured data is derived from the same block data
 * that produced the markup.
 */

export interface RenderContext {
  page: Page;
  brandKit: BrandKit;
  /** Assets referenced by blocks, keyed by id. */
  assets: Map<string, Asset>;
  breakpoint?: Breakpoint;
  /** Absolute site origin, needed for canonical and OG tags. */
  origin: string;
  now?: Date;
  /** Preview mode renders scheduled/hidden blocks with an outline. */
  preview?: boolean;
}

/* ------------------------------------------------------------------ */
/* Escaping and sanitization                                           */
/* ------------------------------------------------------------------ */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(input: unknown): string {
  return String(input ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
}

export function escapeAttr(input: unknown): string {
  return escapeHtml(input);
}

/** Only allow schemes that cannot execute script. */
export function safeUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (raw === '') return '';
  if (/^(https?:|mailto:|tel:|sms:|\/|#|\?)/i.test(raw)) return escapeAttr(raw);
  return '';
}

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'ul', 'ol', 'li', 'a',
  'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'span', 'div',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'figure', 'figcaption', 'img',
]);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading']),
  th: new Set(['scope', 'colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
};

/**
 * Minimal allow-list sanitizer for rich-text and the `html` block.
 *
 * Note: this is the last line of defence, not the only one — user-supplied
 * HTML is also sanitized on write, and the published site sets a strict CSP.
 * Anything not on the allow-list is dropped rather than escaped, so a stripped
 * tag leaves readable text behind.
 */
export function sanitizeHtml(input: string): string {
  let out = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|link|meta)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|link|meta)\b[^>]*\/?>/gi, '');

  out = out.replace(/<(\/?)([a-z0-9]+)((?:\s+[^<>]*)?)>/gi, (_full, slash: string, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    if (slash) return `</${name}>`;

    const allowed = ALLOWED_ATTRS[name];
    if (!allowed) return `<${name}>`;

    const kept: string[] = [];
    for (const m of attrs.matchAll(/([a-z-]+)\s*=\s*"([^"]*)"|([a-z-]+)\s*=\s*'([^']*)'/gi)) {
      const key = (m[1] ?? m[3] ?? '').toLowerCase();
      const value = m[2] ?? m[4] ?? '';
      if (!allowed.has(key)) continue;
      if (key === 'href' || key === 'src') {
        const safe = safeUrl(value);
        if (!safe) continue;
        kept.push(`${key}="${safe}"`);
      } else {
        kept.push(`${key}="${escapeAttr(value)}"`);
      }
    }
    // External links always get noopener — reverse tabnabbing is a real risk.
    if (name === 'a' && kept.some((k) => k.startsWith('target='))) {
      if (!kept.some((k) => k.startsWith('rel='))) kept.push('rel="noopener noreferrer"');
    }
    return `<${name}${kept.length ? ` ${kept.join(' ')}` : ''}>`;
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* Block rendering                                                     */
/* ------------------------------------------------------------------ */

type Props = Record<string, unknown>;

const str = (p: Props, key: string): string | undefined =>
  typeof p[key] === 'string' && p[key] !== '' ? (p[key] as string) : undefined;

const arr = <T,>(p: Props, key: string): T[] =>
  Array.isArray(p[key]) ? (p[key] as T[]) : [];

interface LinkProps { label: string; href: string; style?: string; newTab?: boolean }
interface ImageProps { assetId?: string; url?: string; alt?: string }

function renderButtons(links: LinkProps[]): string {
  if (links.length === 0) return '';
  const items = links.map((l) => {
    const href = safeUrl(l.href);
    if (!href) return '';
    const target = l.newTab ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a class="sl-btn sl-btn--${escapeAttr(l.style ?? 'primary')}" href="${href}"${target}>${escapeHtml(l.label)}</a>`;
  }).filter(Boolean).join('');
  return items ? `<div class="sl-buttons">${items}</div>` : '';
}

function renderImage(
  image: ImageProps | undefined,
  ctx: RenderContext,
  opts: { displayWidth: number; aspect?: number; isHero?: boolean; className?: string },
): string {
  if (!image) return '';
  const cls = opts.className ?? 'sl-image';

  if (image.assetId) {
    const asset = ctx.assets.get(image.assetId);
    if (asset) {
      const r = responsiveImage(asset, {
        displayWidth: opts.displayWidth,
        ...(opts.aspect !== undefined ? { aspect: opts.aspect } : {}),
        ...(opts.isHero !== undefined ? { isHero: opts.isHero } : {}),
      });
      const alt = image.alt ?? r.alt;
      return `<img class="${cls}" src="${escapeAttr(r.src)}" srcset="${escapeAttr(r.srcset)}" sizes="${escapeAttr(r.sizes)}"` +
        ` width="${r.width}" height="${r.height}" alt="${escapeAttr(alt)}" loading="${r.loading}" decoding="${r.decoding}"` +
        `${r.fetchPriority ? ` fetchpriority="${r.fetchPriority}"` : ''}>`;
    }
  }

  const url = safeUrl(image.url);
  if (!url) return '';
  // alt="" is correct for decorative images; a missing alt attribute is not.
  return `<img class="${cls}" src="${url}" alt="${escapeAttr(image.alt ?? '')}" loading="${opts.isHero ? 'eager' : 'lazy'}" decoding="async">`;
}

function sectionAttrs(block: Block, ctx: RenderContext): string {
  const classes = ['sl-block', `sl-block--${block.type}`];
  if (block.style.scheme === 'dark') classes.push('sl-scheme-dark');
  if (block.style.scheme === 'light') classes.push('sl-scheme-light');
  if (block.style.align) classes.push(`sl-align-${block.style.align}`);
  if (block.style.animation !== 'none') classes.push(`sl-anim-${block.style.animation}`);
  if (block.style.customClass) classes.push(block.style.customClass.replace(/[^\w -]/g, ''));
  for (const bp of block.visibility.hiddenOn) classes.push(`sl-hide-${bp}`);

  const bp = ctx.breakpoint ?? 'desktop';
  const styles: string[] = [];
  const pt = resolveResponsive(block.style.paddingTop as string | undefined, bp);
  const pb = resolveResponsive(block.style.paddingBottom as string | undefined, bp);
  if (pt) styles.push(`padding-top:${escapeAttr(pt)}`);
  if (pb) styles.push(`padding-bottom:${escapeAttr(pb)}`);
  if (block.style.background) styles.push(`background:var(--sl-color-${escapeAttr(block.style.background)},${escapeAttr(block.style.background)})`);
  if (block.style.maxWidth) styles.push(`--sl-block-max-width:${escapeAttr(block.style.maxWidth)}`);

  return `class="${classes.join(' ')}" id="block-${escapeAttr(block.id)}"${styles.length ? ` style="${styles.join(';')}"` : ''}`;
}

function heading(level: 2 | 3, text: string | undefined, cls = 'sl-heading'): string {
  return text ? `<h${level} class="${cls}">${escapeHtml(text)}</h${level}>` : '';
}

export function renderBlock(block: Block, ctx: RenderContext): string {
  const p = block.props as Props;
  const attrs = sectionAttrs(block, ctx);
  const wrap = (inner: string, tag = 'section') => `<${tag} ${attrs}>${inner}</${tag}>`;

  switch (block.type) {
    case 'hero': {
      const image = p['image'] as ImageProps | undefined;
      const overlay = str(p, 'overlay') ?? 'none';
      const media = image ? renderImage(image, ctx, { displayWidth: 2400, aspect: 16 / 9, isHero: true, className: 'sl-hero__image' }) : '';
      return wrap(
        `${media}${overlay !== 'none' ? `<div class="sl-hero__overlay sl-hero__overlay--${escapeAttr(overlay)}" aria-hidden="true"></div>` : ''}` +
        `<div class="sl-hero__content sl-hero__content--${escapeAttr(str(p, 'layout') ?? 'centered')}">` +
        (str(p, 'eyebrow') ? `<p class="sl-eyebrow">${escapeHtml(str(p, 'eyebrow'))}</p>` : '') +
        `<h1 class="sl-hero__heading">${escapeHtml(str(p, 'heading') ?? '')}</h1>` +
        (str(p, 'subheading') ? `<p class="sl-hero__subheading">${escapeHtml(str(p, 'subheading'))}</p>` : '') +
        renderButtons(arr<LinkProps>(p, 'buttons')) +
        '</div>',
      );
    }

    case 'text': {
      const columns = typeof p['columns'] === 'number' ? p['columns'] : 1;
      return wrap(
        heading(2, str(p, 'heading')) +
        `<div class="sl-prose" style="--sl-columns:${columns}">${sanitizeHtml(str(p, 'body') ?? '')}</div>`,
      );
    }

    case 'text_image': {
      const position = str(p, 'imagePosition') ?? 'right';
      return wrap(
        `<div class="sl-split sl-split--image-${escapeAttr(position)}">` +
        `<div class="sl-split__text">${heading(2, str(p, 'heading'))}<div class="sl-prose">${sanitizeHtml(str(p, 'body') ?? '')}</div>${renderButtons(arr<LinkProps>(p, 'buttons'))}</div>` +
        `<div class="sl-split__media">${renderImage(p['image'] as ImageProps, ctx, { displayWidth: 800, aspect: 4 / 3 })}</div>` +
        '</div>',
      );
    }

    case 'services': {
      const items = arr<{ name: string; description?: string; href?: string; price?: string }>(p, 'items');
      if (items.length === 0) return '';
      const cols = typeof p['columns'] === 'number' ? p['columns'] : 3;
      const cards = items.map((item) => {
        const title = item.href
          ? `<h3 class="sl-card__title"><a href="${safeUrl(item.href)}">${escapeHtml(item.name)}</a></h3>`
          : `<h3 class="sl-card__title">${escapeHtml(item.name)}</h3>`;
        return `<li class="sl-card">${title}` +
          (item.description ? `<p class="sl-card__body">${escapeHtml(item.description)}</p>` : '') +
          (item.price ? `<p class="sl-card__price">${escapeHtml(item.price)}</p>` : '') +
          '</li>';
      }).join('');
      return wrap(
        heading(2, str(p, 'heading')) +
        (str(p, 'intro') ? `<p class="sl-intro">${escapeHtml(str(p, 'intro'))}</p>` : '') +
        `<ul class="sl-grid" style="--sl-columns:${cols}">${cards}</ul>`,
      );
    }

    case 'team': {
      const members = arr<{ name: string; role?: string; bio?: string; image?: ImageProps }>(p, 'members');
      if (members.length === 0) return '';
      const shape = str(p, 'photoShape') ?? 'circle';
      const cards = members.map((m) =>
        `<li class="sl-person sl-person--${escapeAttr(shape)}">` +
        (m.image ? renderImage(m.image, ctx, { displayWidth: 400, aspect: 1, className: 'sl-person__photo' }) : '') +
        `<h3 class="sl-person__name">${escapeHtml(m.name)}</h3>` +
        (m.role ? `<p class="sl-person__role">${escapeHtml(m.role)}</p>` : '') +
        (m.bio ? `<p class="sl-person__bio">${escapeHtml(m.bio)}</p>` : '') +
        '</li>').join('');
      return wrap(
        heading(2, str(p, 'heading')) +
        `<ul class="sl-grid" style="--sl-columns:${typeof p['columns'] === 'number' ? p['columns'] : 3}">${cards}</ul>`,
      );
    }

    case 'testimonials': {
      const items = arr<{ quote: string; author?: string; role?: string; rating?: number }>(p, 'items');
      if (items.length === 0) return '';
      const cards = items.map((t) =>
        '<li class="sl-testimonial"><figure>' +
        (typeof t.rating === 'number'
          ? `<p class="sl-rating" aria-label="${t.rating} out of 5 stars">${'★'.repeat(Math.round(t.rating))}${'☆'.repeat(5 - Math.round(t.rating))}</p>`
          : '') +
        `<blockquote>${escapeHtml(t.quote)}</blockquote>` +
        (t.author ? `<figcaption>${escapeHtml(t.author)}${t.role ? `, ${escapeHtml(t.role)}` : ''}</figcaption>` : '') +
        '</figure></li>').join('');
      return wrap(heading(2, str(p, 'heading')) + `<ul class="sl-testimonials sl-testimonials--${escapeAttr(str(p, 'layout') ?? 'cards')}">${cards}</ul>`);
    }

    case 'faq': {
      const items = arr<{ question: string; answer: string }>(p, 'items');
      if (items.length === 0) return '';
      // <details>/<summary> is keyboard- and screen-reader-accessible with no JS.
      const entries = items.map((f) =>
        `<details class="sl-faq__item"><summary class="sl-faq__question">${escapeHtml(f.question)}</summary>` +
        `<div class="sl-faq__answer sl-prose">${sanitizeHtml(f.answer)}</div></details>`).join('');
      return wrap(heading(2, str(p, 'heading')) + `<div class="sl-faq">${entries}</div>`);
    }

    case 'gallery': {
      const images = arr<ImageProps>(p, 'images');
      if (images.length === 0) return '';
      const cells = images.map((img) =>
        `<li class="sl-gallery__item">${renderImage(img, ctx, { displayWidth: 800, aspect: 4 / 3 })}</li>`).join('');
      return wrap(
        heading(2, str(p, 'heading')) +
        `<ul class="sl-gallery sl-gallery--${escapeAttr(str(p, 'layout') ?? 'grid')}" style="--sl-columns:${typeof p['columns'] === 'number' ? p['columns'] : 3}">${cells}</ul>`,
      );
    }

    case 'cta':
      return wrap(
        `<div class="sl-cta sl-cta--${escapeAttr(str(p, 'layout') ?? 'banner')}">` +
        `<h2 class="sl-cta__heading">${escapeHtml(str(p, 'heading') ?? '')}</h2>` +
        (str(p, 'body') ? `<p class="sl-cta__body">${escapeHtml(str(p, 'body'))}</p>` : '') +
        renderButtons(arr<LinkProps>(p, 'buttons')) +
        '</div>',
      );

    case 'banner': {
      const link = p['link'] as LinkProps | undefined;
      const role = str(p, 'tone') === 'urgent' ? ' role="alert"' : '';
      return `<aside ${attrs}${role}><p class="sl-banner__message">${escapeHtml(str(p, 'message') ?? '')}` +
        (link ? ` <a href="${safeUrl(link.href)}">${escapeHtml(link.label)}</a>` : '') + '</p>' +
        (p['dismissible'] === false ? '' : '<button type="button" class="sl-banner__dismiss" aria-label="Dismiss announcement">×</button>') +
        '</aside>';
    }

    case 'stats': {
      const items = arr<{ value: string; label: string; description?: string }>(p, 'items');
      if (items.length === 0) return '';
      const cells = items.map((s) =>
        `<li class="sl-stat"><span class="sl-stat__value">${escapeHtml(s.value)}</span>` +
        `<span class="sl-stat__label">${escapeHtml(s.label)}</span>` +
        (s.description ? `<span class="sl-stat__desc">${escapeHtml(s.description)}</span>` : '') + '</li>').join('');
      return wrap(heading(2, str(p, 'heading')) + `<ul class="sl-stats">${cells}</ul>`);
    }

    case 'pricing': {
      const tiers = arr<{ name: string; price: string; period?: string; description?: string; features?: string[]; button?: LinkProps; highlighted?: boolean }>(p, 'tiers');
      if (tiers.length === 0) return '';
      const cards = tiers.map((t) =>
        `<li class="sl-tier${t.highlighted ? ' sl-tier--highlighted' : ''}">` +
        `<h3 class="sl-tier__name">${escapeHtml(t.name)}</h3>` +
        `<p class="sl-tier__price">${escapeHtml(t.price)}${t.period ? `<span class="sl-tier__period">/${escapeHtml(t.period)}</span>` : ''}</p>` +
        (t.description ? `<p class="sl-tier__desc">${escapeHtml(t.description)}</p>` : '') +
        (t.features?.length ? `<ul class="sl-tier__features">${t.features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : '') +
        (t.button ? renderButtons([t.button]) : '') +
        '</li>').join('');
      return wrap(heading(2, str(p, 'heading')) + `<ul class="sl-pricing">${cards}</ul>`);
    }

    case 'contact': {
      // Values are injected at publish time from the knowledge graph; the
      // renderer only lays out the slots that were enabled.
      const rows: string[] = [];
      if (p['showPhone']) rows.push('<div class="sl-contact__row" data-field="phone"></div>');
      if (p['showEmail']) rows.push('<div class="sl-contact__row" data-field="email"></div>');
      if (p['showAddress']) rows.push('<div class="sl-contact__row" data-field="address"></div>');
      if (p['showHours']) rows.push('<div class="sl-contact__row" data-field="hours"></div>');
      return wrap(heading(2, str(p, 'heading')) + `<div class="sl-contact">${rows.join('')}</div>`);
    }

    case 'map': {
      const label = 'Map showing our location';
      return wrap(
        `<div class="sl-map" style="height:${escapeAttr(str(p, 'height') ?? '400px')}" data-location="${escapeAttr(str(p, 'locationId') ?? '')}" data-zoom="${escapeAttr(String(p['zoom'] ?? 14))}" role="img" aria-label="${label}"></div>` +
        (p['showDirectionsLink'] !== false ? '<p class="sl-map__directions"><a href="#" data-directions>Get directions</a></p>' : ''),
      );
    }

    case 'form': {
      const formId = str(p, 'formId') ?? '';
      return wrap(
        heading(2, str(p, 'heading')) +
        (str(p, 'description') ? `<p class="sl-intro">${escapeHtml(str(p, 'description'))}</p>` : '') +
        `<form class="sl-form sl-form--${escapeAttr(str(p, 'layout') ?? 'stacked')}" method="post" action="/api/forms/${escapeAttr(formId)}/submissions" data-form-id="${escapeAttr(formId)}">` +
        // Fields are injected from the Form definition at publish time.
        '<div class="sl-form__fields" data-form-fields></div>' +
        `<button type="submit" class="sl-btn sl-btn--primary">${escapeHtml(str(p, 'submitLabel') ?? 'Send')}</button>` +
        `<p class="sl-form__success" role="status" hidden>${escapeHtml(str(p, 'successMessage') ?? '')}</p>` +
        '</form>',
      );
    }

    case 'video': {
      const url = safeUrl(str(p, 'url'));
      if (!url) return '';
      const isEmbed = /youtube|youtu\.be|vimeo|wistia/.test(url);
      const inner = isEmbed
        ? `<iframe class="sl-video__frame" src="${url}" title="${escapeAttr(str(p, 'caption') ?? 'Video')}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`
        : `<video class="sl-video__player" src="${url}" ${p['autoplay'] ? 'autoplay ' : ''}${p['loop'] ? 'loop ' : ''}${p['muted'] ? 'muted ' : ''}controls playsinline preload="metadata"></video>`;
      return wrap(`<figure class="sl-video">${inner}${str(p, 'caption') ? `<figcaption>${escapeHtml(str(p, 'caption'))}</figcaption>` : ''}</figure>`);
    }

    case 'downloads': {
      const files = arr<{ title: string; url: string; sizeBytes?: number; mimeType?: string }>(p, 'files');
      if (files.length === 0) return '';
      const items = files.map((f) => {
        const href = safeUrl(f.url);
        if (!href) return '';
        const size = f.sizeBytes ? ` <span class="sl-download__size">(${formatBytes(f.sizeBytes)})</span>` : '';
        return `<li class="sl-download"><a href="${href}" download>${escapeHtml(f.title)}</a>${size}</li>`;
      }).join('');
      return wrap(heading(2, str(p, 'heading')) + `<ul class="sl-downloads">${items}</ul>`);
    }

    case 'logo_cloud': {
      const logos = arr<ImageProps>(p, 'logos');
      if (logos.length === 0) return '';
      return wrap(
        heading(2, str(p, 'heading')) +
        `<ul class="sl-logos${p['grayscale'] ? ' sl-logos--grayscale' : ''}">` +
        logos.map((l) => `<li>${renderImage(l, ctx, { displayWidth: 200, aspect: 3 / 2 })}</li>`).join('') +
        '</ul>',
      );
    }

    case 'spacer': {
      const h = resolveResponsive(p['height'] as string, ctx.breakpoint ?? 'desktop') ?? '48px';
      return `<div ${attrs} style="height:${escapeAttr(h)}" aria-hidden="true"></div>`;
    }

    case 'html':
      return wrap(`<div class="sl-custom-html">${sanitizeHtml(str(p, 'content') ?? '')}</div>`, 'div');

    // Blocks whose content is resolved server-side at publish time render a
    // placeholder the publisher fills; this keeps the renderer synchronous.
    case 'products':
    case 'calendar':
    case 'event':
    case 'booking':
    case 'social_feed':
      return wrap(
        heading(2, str(p, 'heading')) +
        `<div class="sl-dynamic" data-block-type="${escapeAttr(block.type)}" data-props="${escapeAttr(JSON.stringify(p))}"></div>`,
      );

    default:
      return '';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Render the visible blocks of a page. */
export function renderBlocks(ctx: RenderContext): string {
  const now = ctx.now ?? new Date();
  const bp = ctx.breakpoint ?? 'desktop';
  return ctx.page.blocks
    .filter((b) => ctx.preview || isVisibleAt(b, bp, now))
    .map((b) => renderBlock(b, ctx))
    .filter(Boolean)
    .join('\n');
}

/** Base stylesheet: tokens plus the layout primitives blocks rely on. */
export function renderStyles(kit: BrandKit): string {
  return `${toCssVariables(kit)}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:var(--sl-font-body);font-size:var(--sl-text-body);line-height:var(--sl-line-height);color:var(--sl-color-text);background:var(--sl-color-background)}
h1,h2,h3,h4{font-family:var(--sl-font-heading);line-height:var(--sl-line-height-heading);letter-spacing:var(--sl-letter-spacing);margin:0 0 var(--sl-space-4)}
h1{font-size:var(--sl-text-h1)}h2{font-size:var(--sl-text-h2)}h3{font-size:var(--sl-text-h3)}
img{max-width:100%;height:auto;display:block}
a{color:var(--sl-color-primary)}
.sl-block{padding:var(--sl-space-9) var(--sl-space-6);max-width:var(--sl-block-max-width,1200px);margin-inline:auto}
.sl-scheme-dark{background:var(--sl-color-text);color:var(--sl-color-background);--sl-color-text:var(--sl-color-background)}
.sl-grid{display:grid;grid-template-columns:repeat(var(--sl-columns,3),1fr);gap:var(--sl-space-7);list-style:none;padding:0;margin:0}
@media(max-width:768px){.sl-grid{grid-template-columns:1fr}.sl-block{padding:var(--sl-space-7) var(--sl-space-5)}}
@media(min-width:769px) and (max-width:1023px){.sl-grid{grid-template-columns:repeat(min(var(--sl-columns,3),2),1fr)}}
.sl-btn{display:inline-block;padding:var(--sl-space-4) var(--sl-space-6);border-radius:var(--sl-radius-md);text-decoration:none;font-weight:600}
.sl-btn--primary{background:var(--sl-color-primary);color:var(--sl-color-on-primary)}
.sl-btn--secondary{background:transparent;color:var(--sl-color-primary);border:var(--sl-border-width) solid var(--sl-color-primary)}
.sl-btn:focus-visible,a:focus-visible,summary:focus-visible,button:focus-visible{outline:3px solid var(--sl-color-primary);outline-offset:2px}
.sl-buttons{display:flex;gap:var(--sl-space-4);flex-wrap:wrap;margin-top:var(--sl-space-6)}
.sl-hero{position:relative}
.sl-hero__overlay{position:absolute;inset:0}
.sl-hero__overlay--dark{background:rgb(0 0 0/.45)}
.sl-hero__overlay--gradient{background:linear-gradient(180deg,rgb(0 0 0/.15),rgb(0 0 0/.6))}
.sl-hero__content{position:relative}
.sl-split{display:grid;grid-template-columns:1fr 1fr;gap:var(--sl-space-8);align-items:center}
.sl-split--image-left .sl-split__media{order:-1}
@media(max-width:768px){.sl-split{grid-template-columns:1fr}.sl-split--image-left .sl-split__media{order:0}}
.sl-card,.sl-person,.sl-testimonial,.sl-tier{background:var(--sl-color-surface);border:var(--sl-border-width) solid var(--sl-color-border);border-radius:var(--sl-radius-lg);padding:var(--sl-space-6);box-shadow:var(--sl-shadow-sm)}
.sl-person--circle .sl-person__photo{border-radius:var(--sl-radius-full);aspect-ratio:1;object-fit:cover}
.sl-testimonials{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:var(--sl-space-6);list-style:none;padding:0}
.sl-testimonial blockquote{margin:0;font-size:var(--sl-text-body-lg)}
.sl-faq__item{border-bottom:var(--sl-border-width) solid var(--sl-color-border);padding:var(--sl-space-5) 0}
.sl-faq__question{cursor:pointer;font-weight:600}
.sl-gallery{display:grid;grid-template-columns:repeat(var(--sl-columns,3),1fr);gap:var(--sl-space-4);list-style:none;padding:0}
.sl-stats{display:flex;flex-wrap:wrap;gap:var(--sl-space-8);list-style:none;padding:0}
.sl-stat{display:flex;flex-direction:column}
.sl-stat__value{font-size:var(--sl-text-h2);font-weight:700;font-family:var(--sl-font-heading)}
.sl-pricing{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:var(--sl-space-6);list-style:none;padding:0}
.sl-tier--highlighted{border-color:var(--sl-color-primary);box-shadow:var(--sl-shadow-lg)}
.sl-form__fields{display:grid;gap:var(--sl-space-5)}
.sl-video__frame{width:100%;aspect-ratio:16/9;border:0}
.sl-logos{display:flex;flex-wrap:wrap;gap:var(--sl-space-7);list-style:none;padding:0;align-items:center}
.sl-logos--grayscale img{filter:grayscale(1);opacity:.7}
.sl-hide-mobile{display:none}
@media(min-width:768px){.sl-hide-mobile{display:revert}.sl-hide-tablet{display:none}}
@media(min-width:1024px){.sl-hide-tablet{display:revert}.sl-hide-desktop{display:none}}
.sl-skip-link{position:absolute;left:-9999px}
.sl-skip-link:focus{left:var(--sl-space-4);top:var(--sl-space-4);z-index:100;background:var(--sl-color-background);padding:var(--sl-space-4);border-radius:var(--sl-radius-md)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
}

/** Full standalone document — what the publisher writes to storage. */
export function renderPage(ctx: RenderContext, opts: { head?: string; navHtml?: string; footerHtml?: string } = {}): string {
  const lang = ctx.page.locale || 'en';
  return `<!doctype html>
<html lang="${escapeAttr(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${opts.head ?? ''}
<style>${renderStyles(ctx.brandKit)}</style>
</head>
<body>
<a class="sl-skip-link" href="#main">Skip to content</a>
${opts.navHtml ?? ''}
<main id="main">
${renderBlocks(ctx)}
</main>
${opts.footerHtml ?? ''}
</body>
</html>`;
}

/** Exposed for the editor's live style preview. */
export function previewButtonContrast(kit: BrandKit): { background: string; text: string } {
  return { background: kit.colors.primary, text: readableTextOn(kit.colors.primary) };
}
