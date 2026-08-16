import { describe, expect, it } from 'vitest';
import { SiteAssistant, type AssistantSiteState } from '../src/ai/assistant.ts';
import { ProviderRegistry } from '../src/ai/provider.ts';
import { MockTextProvider } from '../src/ai/providers/mock.ts';
import type { Page } from '../src/blocks/page.ts';
import { apply, MemoryDocumentStore, readPath, summarize } from '../src/core/changeset.ts';
import { asId, type SiteId, type UserId } from '../src/core/ids.ts';
import { DEFAULT_BRAND_KIT } from '../src/design/brand-kit.ts';

const SITE = asId<SiteId>('site_1');
const USER = asId<UserId>('usr_1');

function page(id: string, path: string, title: string, blocks: Page['blocks']): Page {
  return {
    id, siteId: SITE, path, title, blocks,
    seo: { noindex: false, metaTitle: title },
    status: 'published', order: 0, locale: 'en', updatedAt: '2026-08-01T00:00:00Z',
  };
}

function block(id: string, type: string, props: Record<string, unknown>) {
  return {
    id, type: type as Page['blocks'][number]['type'], props,
    style: { scheme: 'inherit' as const, animation: 'none' as const },
    visibility: { hiddenOn: [], requiresAuth: false },
    locked: false,
  };
}

function state(): AssistantSiteState {
  return {
    siteId: SITE,
    brandKit: DEFAULT_BRAND_KIT,
    siteContext: { businessName: 'Acme Roofing', industry: 'trades' },
    pages: [
      page('page_home', '/', 'Home', [
        block('b1', 'hero', { heading: 'Roofing you can rely on', buttons: [{ label: 'Call 902-555-1234', href: 'tel:9025551234', style: 'primary', newTab: false }] }),
        block('b2', 'cta', { heading: 'Call us at (902) 555-1234 today', buttons: [] }),
      ]),
      page('page_contact', '/contact', 'Contact', [
        block('b3', 'contact', { heading: 'Reach us at 902.555.1234 or info@acmeroofing.ca' }),
      ]),
    ],
  };
}

const assistant = new SiteAssistant(new ProviderRegistry().register('mock', { text: new MockTextProvider() }));

describe('deterministic intent handling', () => {
  it('replaces every phone number, including tel: links', async () => {
    const result = await assistant.plan({ intent: 'Change all phone numbers to 902-555-9876', actorId: USER, state: state() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.strategy).toBe('deterministic');
    const summary = summarize(result.value.changeSet);
    expect(summary.byResourceType['page']).toBe(2);

    const afters = result.value.changeSet.operations.map((o) => (o.op === 'set' ? o.after : null));
    expect(afters).toContain('tel:9025559876');
    expect(afters.some((a) => typeof a === 'string' && a.includes('902-555-9876'))).toBe(true);
    expect(afters.some((a) => typeof a === 'string' && a.includes('555-1234'))).toBe(false);
  });

  it('applies the plan to a store and produces the new values', async () => {
    const s = state();
    const result = await assistant.plan({ intent: 'Change all phone numbers to 902-555-9876', actorId: USER, state: s });
    if (!result.ok) throw new Error('plan failed');

    const store = MemoryDocumentStore.from(
      s.pages.map((p) => [{ type: 'page' as const, id: p.id, label: p.title }, p]),
    );
    const applied = apply(store, result.value.changeSet);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const home = applied.value.store.get({ type: 'page', id: 'page_home' });
    expect(readPath(home, 'blocks.1.props.heading')).toContain('902-555-9876');
  });

  it('rejects an incomplete phone number instead of guessing', async () => {
    const result = await assistant.plan({ intent: 'Change all phone numbers to 555-12', actorId: USER, state: state() });
    expect(result.ok).toBe(false);
  });

  it('replaces email addresses and mailto links', async () => {
    const result = await assistant.plan({ intent: 'Update all emails to hello@acmeroofing.ca', actorId: USER, state: state() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changeSet.operations.some((o) => o.op === 'set' && String(o.after).includes('hello@acmeroofing.ca'))).toBe(true);
  });

  it('handles quoted find-and-replace', async () => {
    const result = await assistant.plan({ intent: 'Replace "Roofing you can rely on" with "Island roofing done right"', actorId: USER, state: state() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.value.changeSet.operations[0];
    expect(op?.op === 'set' && op.after).toBe('Island roofing done right');
  });

  it('reports when nothing matches rather than inventing a change', async () => {
    const result = await assistant.plan({ intent: 'Replace "nonexistent phrase" with "something"', actorId: USER, state: state() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AI_PLAN_NOT_APPLICABLE');
  });

  it('adds a section at the requested position', async () => {
    const result = await assistant.plan({
      intent: 'Add a testimonials section below the hero',
      actorId: USER, state: state(), scopePageId: 'page_home',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.value.changeSet.operations[0];
    expect(op?.op).toBe('insert');
    if (op?.op === 'insert') expect(op.index).toBe(1);
  });

  it('changes a brand colour and blocks it when contrast fails', async () => {
    const good = await assistant.plan({ intent: 'Use our brand colour #1d4ed8', actorId: USER, state: state() });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.changeSet.warnings.some((w) => w.severity === 'blocking')).toBe(false);

    const bad = await assistant.plan({ intent: 'Use our brand colour #f2f2f2', actorId: USER, state: state() });
    expect(bad.ok).toBe(true);
    if (bad.ok) {
      // Near-white primary cannot carry legible button text either way.
      expect(bad.value.changeSet.warnings.some((w) => w.code === 'contrast_below_wcag')).toBe(true);
    }
  });

  it('understands colour names', async () => {
    const result = await assistant.plan({ intent: 'Change the primary colour to teal', actorId: USER, state: state() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const op = result.value.changeSet.operations[0];
    expect(op?.op === 'set' && op.after).toBe('#0d9488');
  });

  it('warns before removing content', async () => {
    const result = await assistant.plan({ intent: 'Remove the cta section', actorId: USER, state: state() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changeSet.operations[0]?.op).toBe('remove');
    expect(result.value.changeSet.warnings[0]?.code).toBe('content_removal');
  });

  it('confines a scoped request to the page being edited', async () => {
    const result = await assistant.plan({
      intent: 'Change all phone numbers to 902-555-9876',
      actorId: USER, state: state(), scopePageId: 'page_contact',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summarize(result.value.changeSet).byResourceType['page']).toBe(1);
  });
});

describe('model-planned edits', () => {
  it('rejects a plan referencing a page that does not exist', async () => {
    const registry = new ProviderRegistry().register('mock', {
      text: new MockTextProvider([{
        match: /Make the homepage less busy/,
        text: JSON.stringify({
          explanation: 'Removes a section.',
          operations: [{ op: 'remove', resourceType: 'page', resourceId: 'page_ghost', path: 'blocks', index: 0 }],
        }),
      }]),
    });
    const result = await new SiteAssistant(registry).plan({
      intent: 'Make the homepage less busy', actorId: USER, state: state(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AI_PLAN_NOT_APPLICABLE');
  });

  it('refuses a model plan that reaches outside the current page scope', async () => {
    const registry = new ProviderRegistry().register('mock', {
      text: new MockTextProvider([{
        match: /tidy/,
        text: JSON.stringify({
          explanation: 'Edits another page.',
          operations: [{ op: 'set', resourceType: 'page', resourceId: 'page_home', path: 'title', value: 'Hacked' }],
        }),
      }]),
    });
    const result = await new SiteAssistant(registry).plan({
      intent: 'tidy this page', actorId: USER, state: state(), scopePageId: 'page_contact',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
  });

  it('accepts a well-formed model plan and flags large changes', async () => {
    const operations = Array.from({ length: 25 }, () => ({
      op: 'set', resourceType: 'page', resourceId: 'page_home', path: 'title', value: 'Home page',
    }));
    const registry = new ProviderRegistry().register('mock', {
      text: new MockTextProvider([{ match: /rewrite/, text: JSON.stringify({ explanation: 'Rewrites titles.', operations }) }]),
    });
    const result = await new SiteAssistant(registry).plan({ intent: 'rewrite all the titles', actorId: USER, state: state() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.strategy).toBe('model');
    expect(result.value.changeSet.warnings.some((w) => w.code === 'large_change')).toBe(true);
  });

  it('surfaces a clear error when no provider can plan the request', async () => {
    const result = await assistant.plan({ intent: 'Make the homepage feel friendlier', actorId: USER, state: state() });
    expect(result.ok).toBe(false);
  });
});

describe('provider registry', () => {
  it('fails over to the next provider on a retryable error', async () => {
    class Flaky extends MockTextProvider {
      override async generateText() {
        return { ok: false as const, error: Object.assign(new Error('boom'), { retryable: true, code: 'AI_PROVIDER_ERROR' }) as never };
      }
    }
    const registry = new ProviderRegistry()
      .register('flaky', { text: new Flaky() }, 1)
      .register('mock', { text: new MockTextProvider() }, 2);

    const result = await registry.generateText({ prompt: 'hello' }, { orgId: 'o', siteId: 's', requestId: 'r' });
    expect(result.ok).toBe(true);
  });

  it('reports a missing capability rather than throwing', async () => {
    const result = await new ProviderRegistry().generateImage(
      { prompt: 'a roof', aspect: '16:9' },
      { orgId: 'o', siteId: 's', requestId: 'r' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('tracks credit usage', async () => {
    const registry = new ProviderRegistry().register('mock', { text: new MockTextProvider() });
    await registry.generateText({ prompt: 'hi' }, { orgId: 'o', siteId: 's', requestId: 'r' });
    expect(registry.totalCredits()).toBeGreaterThan(0);
  });
});
