import { describe, expect, it } from 'vitest';
import {
  apply, applyOperations, createChangeSet, describeImpact, invert,
  MemoryDocumentStore, preview, readPath, revert, summarize, writePath,
  type Operation, type ResourceRef,
} from '../src/core/changeset.ts';
import { asId, type SiteId, type UserId } from '../src/core/ids.ts';

const SITE = asId<SiteId>('site_1');
const USER = asId<UserId>('usr_1');

const homeRef: ResourceRef = { type: 'page', id: 'page_home', label: 'Home' };
const aboutRef: ResourceRef = { type: 'page', id: 'page_about', label: 'About' };

function store() {
  return MemoryDocumentStore.from([
    [homeRef, { title: 'Home', blocks: [{ type: 'hero', props: { heading: 'Welcome' } }, { type: 'cta', props: { heading: 'Call us' } }] }],
    [aboutRef, { title: 'About', blocks: [{ type: 'text', props: { body: 'We started in 1998.' } }] }],
  ]);
}

describe('path access', () => {
  it('reads nested object and array paths', () => {
    const doc = { blocks: [{ props: { heading: 'Welcome' } }] };
    expect(readPath(doc, 'blocks.0.props.heading')).toBe('Welcome');
    expect(readPath(doc, 'blocks.5.props')).toBeUndefined();
  });

  it('writes immutably', () => {
    const doc = { blocks: [{ props: { heading: 'Welcome' } }] };
    const next = writePath(doc, 'blocks.0.props.heading', 'Hello') as typeof doc;
    expect(next.blocks[0]?.props.heading).toBe('Hello');
    expect(doc.blocks[0]?.props.heading).toBe('Welcome');
  });

  it('creates intermediate objects', () => {
    expect(writePath({}, 'seo.metaTitle', 'X')).toEqual({ seo: { metaTitle: 'X' } });
  });
});

describe('operations', () => {
  it('applies a set and leaves the original store untouched', () => {
    const original = store();
    const result = applyOperations(original, [
      { op: 'set', resource: homeRef, path: 'blocks.0.props.heading', before: 'Welcome', after: 'Welcome home' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(readPath(result.value.store.get(homeRef), 'blocks.0.props.heading')).toBe('Welcome home');
    expect(readPath(original.get(homeRef), 'blocks.0.props.heading')).toBe('Welcome');
  });

  it('refuses a set whose precondition no longer holds', () => {
    const result = applyOperations(store(), [
      { op: 'set', resource: homeRef, path: 'blocks.0.props.heading', before: 'Stale value', after: 'New' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PRECONDITION_FAILED');
  });

  it('is all-or-nothing when a later operation fails', () => {
    const original = store();
    const result = applyOperations(original, [
      { op: 'set', resource: homeRef, path: 'title', before: 'Home', after: 'Homepage' },
      { op: 'set', resource: aboutRef, path: 'title', before: 'Wrong', after: 'About us' },
    ]);
    expect(result.ok).toBe(false);
    expect(readPath(original.get(homeRef), 'title')).toBe('Home');
  });

  it('inserts, removes and moves list items', () => {
    const inserted = applyOperations(store(), [
      { op: 'insert', resource: homeRef, path: 'blocks', index: 1, after: { type: 'testimonials', props: {} } },
    ]);
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const blocks = readPath(inserted.value.store.get(homeRef), 'blocks') as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['hero', 'testimonials', 'cta']);

    const moved = applyOperations(inserted.value.store, [
      { op: 'move', resource: homeRef, path: 'blocks', fromIndex: 0, toIndex: 2 },
    ]);
    if (!moved.ok) throw new Error('move failed');
    expect((readPath(moved.value.store.get(homeRef), 'blocks') as Array<{ type: string }>).map((b) => b.type))
      .toEqual(['testimonials', 'cta', 'hero']);
  });

  it('rejects an out-of-range index', () => {
    const result = applyOperations(store(), [
      { op: 'insert', resource: homeRef, path: 'blocks', index: 9, after: {} },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('inverts every operation type', () => {
    const ops: Operation[] = [
      { op: 'set', resource: homeRef, path: 'title', before: 'a', after: 'b' },
      { op: 'create', resource: homeRef, after: { x: 1 } },
      { op: 'delete', resource: homeRef, before: { x: 1 } },
      { op: 'insert', resource: homeRef, path: 'blocks', index: 0, after: { x: 1 } },
      { op: 'remove', resource: homeRef, path: 'blocks', index: 0, before: { x: 1 } },
      { op: 'move', resource: homeRef, path: 'blocks', fromIndex: 0, toIndex: 2 },
    ];
    expect(ops.map((o) => invert(o).op)).toEqual(['set', 'delete', 'create', 'remove', 'insert', 'move']);
    expect(invert(invert(ops[0] as Operation))).toEqual(ops[0]);
  });
});

describe('change sets', () => {
  const cs = () => createChangeSet({
    siteId: SITE,
    origin: 'ai_assistant',
    title: 'Change all phone numbers',
    createdBy: USER,
    operations: [
      { op: 'set', resource: homeRef, path: 'blocks.0.props.heading', before: 'Welcome', after: 'Welcome home' },
      { op: 'set', resource: homeRef, path: 'title', before: 'Home', after: 'Homepage' },
      { op: 'set', resource: aboutRef, path: 'title', before: 'About', after: 'About us' },
    ],
  });

  it('counts distinct resources, not operations', () => {
    const summary = summarize(cs());
    expect(summary.totalOperations).toBe(3);
    expect(summary.byResourceType['page']).toBe(2);
    expect(summary.fieldsChanged).toBe(3);
  });

  it('renders a readable impact line', () => {
    expect(describeImpact(summarize(cs()))).toEqual(['2 pages', '3 fields']);
  });

  it('previews without mutating the live store', () => {
    const live = store();
    const result = preview(live, cs());
    expect(result.ok).toBe(true);
    expect(readPath(live.get(homeRef), 'title')).toBe('Home');
  });

  it('applies, records an inverse, and reverts cleanly', () => {
    const live = store();
    const applied = apply(live, cs());
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.value.changeSet.status).toBe('applied');
    expect(applied.value.changeSet.inverse).toHaveLength(3);
    expect(readPath(applied.value.store.get(aboutRef), 'title')).toBe('About us');

    const reverted = revert(applied.value.store, applied.value.changeSet);
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) return;
    expect(readPath(reverted.value.store.get(aboutRef), 'title')).toBe('About');
    expect(readPath(reverted.value.store.get(homeRef), 'title')).toBe('Home');
    expect(reverted.value.changeSet.status).toBe('reverted');
  });

  it('refuses to apply with a blocking warning outstanding', () => {
    const blocked = { ...cs(), warnings: [{ severity: 'blocking' as const, code: 'contrast', message: 'fails WCAG' }] };
    const result = apply(store(), blocked);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PRECONDITION_FAILED');
  });

  it('refuses to apply the same change set twice', () => {
    const live = store();
    const first = apply(live, cs());
    if (!first.ok) throw new Error('setup failed');
    expect(apply(first.value.store, first.value.changeSet).ok).toBe(false);
  });

  it('will not revert something that was never applied', () => {
    expect(revert(store(), cs()).ok).toBe(false);
  });
});
