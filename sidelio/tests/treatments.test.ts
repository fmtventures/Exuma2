import { describe, expect, it } from 'vitest';
import {
  TREATMENTS, TREATMENT_IDS, TREATMENT_LIST,
  treatmentClasses, treatmentCss, treatmentsByCategory,
} from '../src/render/treatments.ts';
import { TEMPLATES } from '../src/generate/templates.ts';

describe('treatment catalog', () => {
  it('offers devices across every category, not just motion', () => {
    for (const category of ['motion', 'type', 'surface', 'media', 'detail'] as const) {
      expect(treatmentsByCategory(category).length).toBeGreaterThanOrEqual(3);
    }
    expect(TREATMENT_LIST.length).toBeGreaterThanOrEqual(15);
  });

  it('ships only the treatments asked for', () => {
    const css = treatmentCss(['grain']);
    expect(css).toContain('sl-tr-grain');
    expect(css).not.toContain('sl-tr-duotone');
    expect(css).not.toContain('sl-marquee');
  });

  it('ignores unknown ids rather than emitting dead classes', () => {
    expect(treatmentClasses(['grain', 'not-a-treatment'])).toBe('sl-tr sl-tr-grain');
    expect(treatmentCss(['not-a-treatment'])).toBe('');
    expect(treatmentClasses([])).toBe('');
  });

  it('adds interaction feedback whenever any treatment is active', () => {
    // A page with hover states on nothing is the defect this layer exists to
    // fix; the base must come along with any treatment at all.
    const css = treatmentCss(['numbered']);
    expect(css).toContain(':hover');
    expect(css).toContain('transition:');
  });
});

describe('treatments never trap content', () => {
  /**
   * The base stylesheet kills all animation under prefers-reduced-motion with
   * `*{animation:none!important}`. Any treatment whose *initial* state hides
   * content and whose animation reveals it would leave the page permanently
   * blank there — and equally on any engine without scroll-driven animations.
   */
  const hidingTreatments = ['reveal', 'stagger'] as const;

  it.each(hidingTreatments)('guards %s behind support and motion queries', (id) => {
    const css = TREATMENTS[id].css;
    const opacityZero = css.indexOf('opacity: 0');
    expect(opacityZero).toBeGreaterThan(-1);

    // Every hidden state must live inside both guards.
    const supportsAt = css.indexOf('@supports (animation-timeline: view())');
    const motionAt = css.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(supportsAt).toBeGreaterThan(-1);
    expect(motionAt).toBeGreaterThan(supportsAt);

    // The only `opacity: 0` is inside the keyframe, which is inert when the
    // animation never attaches — content stays visible by default.
    expect(css.slice(0, opacityZero)).toContain('@keyframes');
    expect(css.indexOf('.sl-tr-')).toBeGreaterThan(opacityZero);
  });

  it('never sets a bare hidden state outside a keyframe', () => {
    for (const id of TREATMENT_IDS) {
      const rules = TREATMENTS[id].css
        .split('}')
        // A generated pseudo-element is decoration by definition — fading a
        // duotone overlay out on hover reveals content rather than hiding it.
        .filter((r) => r.includes('.sl-tr-') && !/::(after|before)/.test(r))
        .filter((r) => /opacity:\s*0\s*[;]/.test(r));
      expect(rules, `${id} hides content in a live rule`).toEqual([]);
    }
  });

  it('gives continuous motion a reduced-motion fallback that keeps content reachable', () => {
    // The marquee is the hard case: stopping it without another affordance
    // truncates the list rather than pausing it.
    const css = TREATMENTS.marquee.css;
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('overflow-x: auto');
  });

  it('keeps a visible underline for links when motion is off', () => {
    const css = TREATMENTS.underline.css;
    expect(css).toContain('focus-visible');
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*background-size: 100%/);
  });

  it('keeps decorative numerals out of the accessibility tree', () => {
    // A screen reader announcing "zero three" before every heading is noise.
    expect(TREATMENTS.numbered.css).toContain('speak: never');
    expect(TREATMENTS.numbered.css).toContain('::before');
  });

  it('unwinds transforms under reduced motion in the shared base', () => {
    const css = treatmentCss(['reveal']);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*transform: none/);
  });

  it('unwinds scroll reveals for print', () => {
    // Measured before this existed: printing a revealed page left two of
    // three sections blank, because print never scrolls and the animation
    // that would have revealed them therefore never advanced.
    const css = treatmentCss(['reveal']);
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toContain('opacity: 1 !important');
    expect(print).toContain('animation: none !important');
    // Decoration must keep its intended opacity — forcing generated content
    // to full strength stamps a solid overlay across every image.
    expect(print).not.toMatch(/\*::(before|after)[^{]*\{[^}]*opacity: 1/);
  });
});

describe('treatments carry no network dependency', () => {
  it('inlines texture rather than fetching it', () => {
    // Strip data URIs first: a `url(%23n)` *inside* an inline SVG is a
    // same-document filter reference, not a fetch.
    const css = treatmentCss([...TREATMENT_IDS]).replace(/url\("data:[^"]*"\)/g, '');
    // A published page must render with no external request.
    const urls = css.match(/url\([^)]*\)/g) ?? [];
    expect(urls).toEqual([]);
    expect(TREATMENTS.grain.css).toContain('data:image/svg+xml');
  });

  it('degrades where colour-mix is unsupported instead of losing the section', () => {
    expect(TREATMENTS['gradient-wash'].css).toContain('@supports not (color: color-mix');
  });
});

describe('the design library uses the full range', () => {
  it('gives every design a treatment set', () => {
    for (const t of TEMPLATES) {
      expect(t.treatments.length, `${t.id} has no treatments`).toBeGreaterThanOrEqual(3);
      for (const id of t.treatments) expect(TREATMENT_IDS).toContain(id);
    }
  });

  it('gives no two designs the same combination', () => {
    // Sixteen designs sharing one treatment set would be the palette-swap
    // problem again, one level up.
    const seen = new Map<string, string>();
    for (const t of TEMPLATES) {
      const key = [...t.treatments].sort().join('+');
      expect(seen.get(key), `${t.id} duplicates ${seen.get(key)}`).toBeUndefined();
      seen.set(key, t.id);
    }
  });

  it('exercises every treatment in the catalog at least once', () => {
    const used = new Set(TEMPLATES.flatMap((t) => t.treatments));
    const unused = TREATMENT_IDS.filter((id) => !used.has(id));
    expect(unused, 'treatments no design uses are dead code').toEqual([]);
  });

  it('separates designs that share a layout', () => {
    // Two designs on the same layout are exactly the pair most at risk of
    // looking identical, so their treatments must differ.
    const byLayout = new Map<string, typeof TEMPLATES>();
    for (const t of TEMPLATES) {
      byLayout.set(t.layout, [...(byLayout.get(t.layout) ?? []), t]);
    }
    for (const [layout, group] of byLayout) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!, b = group[j]!;
          const shared = a.treatments.filter((x) => b.treatments.includes(x));
          const union = new Set([...a.treatments, ...b.treatments]).size;
          expect(
            shared.length / union,
            `${a.id} and ${b.id} both use ${layout} and overlap too heavily`,
          ).toBeLessThan(0.5);
        }
      }
    }
  });
});
