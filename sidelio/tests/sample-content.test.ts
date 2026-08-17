import { describe, expect, it } from 'vitest';
import { fillForPreview, sampleImage } from '../src/generate/sample-content.ts';
import { DEFAULT_BRAND_KIT } from '../src/design/brand-kit.ts';
import { safeImageUrl, safeUrl, renderBlock, renderStyles, sanitizeHtml } from '../src/render/html.ts';
import type { Page } from '../src/blocks/page.ts';
import type { Block } from '../src/blocks/schema.ts';

const KIT = DEFAULT_BRAND_KIT;

function block(type: string, props: Record<string, unknown> = {}): Block {
  return {
    id: `blk_${type}`, siteId: 'site_1', type, props,
    style: { scheme: 'inherit', align: 'left', animation: 'none' },
    visibility: { hiddenOn: [] }, order: 0,
  } as unknown as Block;
}

function page(blocks: Block[]): Page {
  return {
    id: 'pg_1', siteId: 'site_1', path: '/', title: 'Home', blocks,
    seo: { noindex: false }, status: 'draft', order: 0,
    locale: 'en', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('image URLs are judged separately from link URLs', () => {
  it('renders inline image data URIs', () => {
    // Using safeUrl here silently dropped every generated image, because
    // `data:` is barred from hrefs — where data:text/html would execute.
    const uri = 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E';
    expect(safeImageUrl(uri)).toContain('data:image/svg+xml');
    expect(safeUrl(uri)).toBe('');
  });

  it('accepts the image types a browser will actually decode', () => {
    for (const type of ['png', 'jpeg', 'jpg', 'gif', 'webp', 'avif', 'svg+xml']) {
      expect(safeImageUrl(`data:image/${type},x`), type).not.toBe('');
    }
    expect(safeImageUrl('data:image/png;base64,iVBORw0KGgo=')).not.toBe('');
  });

  it('refuses anything claiming to be an image that is not one', () => {
    for (const bad of [
      'data:text/html,<script>alert(1)</script>',
      'data:image/svg+xml;base64,x/../../text/html,y'.replace('image/svg+xml', 'text/html'),
      'javascript:alert(1)',
      'data:application/javascript,alert(1)',
      'data:,plain',
      // A media type is allow-listed, not pattern-matched, so this fails.
      'data:image/html,<script>alert(1)</script>',
      ' data:text/html;image/png,x',
    ]) {
      expect(safeImageUrl(bad), bad).toBe('');
    }
  });

  it('still refuses data URIs inside rich text', () => {
    // Author-supplied HTML is a different trust context from a block's own
    // image slot; it keeps the stricter rule.
    const out = sanitizeHtml('<img src="data:image/png,x" alt="a">');
    expect(out).not.toContain('data:image');
  });

  it('puts a rendered image on the page', () => {
    const html = renderBlock(
      block('gallery', { images: [{ url: sampleImage(KIT, 1), alt: '' }] }),
      { page: page([]), brandKit: KIT, assets: new Map(), origin: 'https://x', preview: true },
    );
    expect(html).toContain('<img');
    expect(html).toContain('data:image/svg+xml');
  });
});

describe('sample artwork', () => {
  it('is deterministic so previews do not churn', () => {
    expect(sampleImage(KIT, 7)).toBe(sampleImage(KIT, 7));
    expect(sampleImage(KIT, 7)).not.toBe(sampleImage(KIT, 8));
  });

  it('is drawn in the design own palette, not grey', () => {
    const kit = { ...KIT, colors: { ...KIT.colors, primary: '#ff0066' } };
    expect(decodeURIComponent(sampleImage(kit, 3))).toContain('#ff0066');
  });

  it('carries no script and no external reference', () => {
    const svg = decodeURIComponent(sampleImage(KIT, 5));
    expect(svg).not.toMatch(/<script|onload=|xlink:href|href=/i);
  });
});

describe('fillForPreview', () => {
  const wantSections = ['hero', 'services', 'stats', 'testimonials', 'gallery', 'cta'] as const;

  it('fills blocks the generator left empty', () => {
    const before = page([block('stats', { items: [] }), block('gallery', { images: [] })]);
    const after = fillForPreview(before, KIT, {});
    for (const b of after.blocks) {
      const html = renderBlock(b, { page: after, brandKit: KIT, assets: new Map(), origin: 'https://x', preview: true });
      expect(html, b.type).not.toBe('');
    }
  });

  it('adds the sections the design composes but the crawler had no data for', () => {
    const before = page([block('hero', { heading: 'Hi' })]);
    const after = fillForPreview(before, KIT, { wantSections });
    const types = after.blocks.map((b) => b.type);
    for (const want of wantSections) {
      if (want === 'cta') continue; // cta needs no data and is never sampled
      expect(types, want).toContain(want);
    }
  });

  it('never mutates the page it was given', () => {
    const before = page([block('stats', { items: [] })]);
    const snapshot = JSON.stringify(before);
    fillForPreview(before, KIT, { wantSections, fillImages: true });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('marks every filled block so nothing downstream mistakes it for a fact', () => {
    const after = fillForPreview(page([block('stats', { items: [] })]), KIT, { wantSections });
    const filled = after.blocks.filter((b) => (b.props as Record<string, unknown>)['sample'] === true);
    expect(filled.length).toBeGreaterThan(0);
    for (const b of filled) expect((b.props as Record<string, unknown>)['sample']).toBe(true);
  });

  it('leaves real content alone', () => {
    const real = block('stats', { items: [{ value: '12', label: 'Years' }] });
    const after = fillForPreview(page([real]), KIT, {});
    const out = after.blocks.find((b) => b.type === 'stats')!;
    expect((out.props as { items: unknown[] }).items).toHaveLength(1);
    expect((out.props as Record<string, unknown>)['sample']).toBeUndefined();
  });

  it('attributes no invented testimonial to a real person', () => {
    // The provenance model exists to stop fabricated claims reaching a page;
    // sample content must not be the hole in it.
    const after = fillForPreview(page([block('testimonials', { items: [] })]), KIT, {});
    const t = after.blocks.find((b) => b.type === 'testimonials')!;
    for (const item of (t.props as { items: { author?: string }[] }).items) {
      expect(item.author?.toLowerCase()).toContain('sample');
    }
  });
});

describe('hero media composes with its overlay', () => {
  const ctx = { page: page([]), brandKit: KIT, assets: new Map(), origin: 'https://x', preview: true };

  it('positions media and overlay against the hero section', () => {
    // The rule was written as `.sl-hero`, a class no element carries, so the
    // overlay positioned against the viewport and the image sat in normal
    // flow — pushing the headline below a full-bleed photograph.
    const css = renderStyles(KIT);
    expect(css).toContain('.sl-block--hero{position:relative');
    expect(css).toMatch(/\.sl-hero__image\{position:absolute/);
    expect(css).not.toMatch(/(^|[^-])\.sl-hero\{/);
  });

  it('scrims hero text when there is media but no overlay', () => {
    const css = renderStyles(KIT);
    expect(css).toContain(':has(.sl-hero__image):not(:has(.sl-hero__overlay))');
    // …and still paints a ground where color-mix is unsupported.
    expect(css).toContain('@supports not (color:color-mix');
  });

  it('renders hero media as a sibling of the content, not inside it', () => {
    const html = renderBlock(
      block('hero', { heading: 'Acme', image: { url: sampleImage(KIT, 2, 16 / 9), alt: '' }, overlay: 'none' }),
      ctx,
    );
    expect(html.indexOf('sl-hero__image')).toBeLessThan(html.indexOf('sl-hero__content'));
    expect(html).toContain('<h1 class="sl-hero__heading">Acme</h1>');
  });
});

describe('hero overlays pair a ground with an ink', () => {
  it('forces legible ink for every overlay that changes the ground', () => {
    const css = renderStyles(KIT);
    // Overlay and text colour were chosen independently, so a dark palette
    // under a dark gradient produced near-black on near-black. The palette
    // contrast audit cannot catch it: both values pass on their own.
    const rule = (sel: string) => {
      const at = css.indexOf(sel);
      expect(at, sel).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };
    // Both dark grounds share one rule, so assert on the declaration the
    // selector actually resolves to rather than on adjacency.
    for (const kind of ['dark', 'gradient']) {
      expect(rule(`:has(.sl-hero__overlay--${kind}) .sl-hero__content`), kind)
        .toContain('--sl-color-text:#fff');
    }
    expect(rule(':has(.sl-hero__overlay--light) .sl-hero__content')).toContain('--sl-color-text:#111');
  });

  it('keeps overlays opaque enough to carry that ink over pale media', () => {
    const css = renderStyles(KIT);
    // Measured on rendered pixels: .45 left white text at 3.5:1 over a pale
    // duotone image — passing only by virtue of being large type.
    const dark = css.match(/--dark\{background:rgb\(0 0 0\/\.(\d+)\)/)?.[1];
    expect(Number(dark)).toBeGreaterThanOrEqual(58);
    const grad = css.match(/--gradient\{background:linear-gradient\(180deg,rgb\(0 0 0\/\.(\d+)\)/)?.[1];
    expect(Number(grad)).toBeGreaterThanOrEqual(35);
  });
});
