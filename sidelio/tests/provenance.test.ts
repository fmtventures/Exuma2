import { describe, expect, it } from 'vitest';
import {
  approve, editValue, effectiveValue, initialApproval, isPublishable,
  makeFact, mergeFact, reject, type SourceRef,
} from '../src/core/provenance.ts';
import { asId, type SiteId } from '../src/core/ids.ts';
import { KnowledgeGraph } from '../src/knowledge/graph.ts';

const crawl: SourceRef = { kind: 'website_crawl', locator: 'https://acme.ca/contact', retrievedAt: '2026-08-01T00:00:00Z' };
const structured: SourceRef = { kind: 'structured_data', locator: 'https://acme.ca/', retrievedAt: '2026-08-01T00:00:00Z' };
const inferred: SourceRef = { kind: 'ai_inference', locator: 'model', retrievedAt: '2026-08-01T00:00:00Z' };
const typed: SourceRef = { kind: 'user_input', locator: 'admin', retrievedAt: '2026-08-01T00:00:00Z' };

describe('fact approval', () => {
  it('auto-approves high-confidence structured data', () => {
    expect(initialApproval('structured_data', 0.95)).toBe('auto_approved');
  });

  it('never auto-approves model output, however confident', () => {
    expect(initialApproval('ai_inference', 0.99)).toBe('needs_review');
    expect(initialApproval('ai_generated', 1)).toBe('needs_review');
  });

  it('treats typed input as approved', () => {
    expect(initialApproval('user_input', 0.5)).toBe('approved');
  });

  it('leaves medium-confidence crawl results pending', () => {
    expect(initialApproval('website_crawl', 0.75)).toBe('pending');
  });
});

describe('publication gate', () => {
  it('blocks an unreviewed model inference', () => {
    expect(isPublishable(makeFact('business.tagline', 'The best in town', inferred))).toBe(false);
  });

  it('blocks a rejected fact even after an edit', () => {
    const rejected = reject(makeFact('business.phone', '902-555-0000', crawl), 'usr_1');
    expect(isPublishable(rejected)).toBe(false);
  });

  it('publishes once a human edits the value', () => {
    const edited = editValue(makeFact('business.phone', '902-555-0000', inferred), '902-555-1234', 'usr_1');
    expect(isPublishable(edited)).toBe(true);
    expect(effectiveValue(edited)).toBe('902-555-1234');
  });

  it('publishes an approved fact', () => {
    expect(isPublishable(approve(makeFact('business.name', 'Acme', crawl), 'usr_1'))).toBe(true);
  });
});

describe('fact merging', () => {
  it('promotes the stronger source to the primary slot', () => {
    const weak = makeFact('business.phone', '902-555-0000', crawl, { confidence: 0.6 });
    const strong = makeFact('business.phone', '902-555-1234', structured, { confidence: 0.95 });
    const merged = mergeFact(weak, strong);
    expect(merged.value).toBe('902-555-1234');
    expect(merged.alternatives?.[0]?.value).toBe('902-555-0000');
  });

  it('flags disagreement for review instead of picking silently', () => {
    const a = makeFact('business.phone', '902-555-0000', structured, { confidence: 0.95 });
    const b = makeFact('business.phone', '902-555-1234', structured, { confidence: 0.9 });
    const merged = mergeFact(a, b);
    expect(merged.approval).toBe('needs_review');
    expect(isPublishable(merged)).toBe(false);
  });

  it('raises confidence when two sources corroborate, without reaching certainty', () => {
    const a = makeFact('business.phone', '902-555-1234', crawl, { confidence: 0.7 });
    const b = makeFact('business.phone', '902-555-1234', crawl, { confidence: 0.75 });
    const merged = mergeFact(a, b);
    expect(merged.confidence).toBeGreaterThan(0.75);
    expect(merged.confidence).toBeLessThan(1);
    expect(merged.alternatives ?? []).toHaveLength(0);
  });

  it('never overrides a human edit with a later crawl', () => {
    const edited = editValue(makeFact('business.phone', '902-555-0000', crawl), '902-555-9999', 'usr_1');
    const merged = mergeFact(edited, makeFact('business.phone', '902-555-1234', structured, { confidence: 0.99 }));
    expect(effectiveValue(merged)).toBe('902-555-9999');
  });
});

describe('knowledge graph projection', () => {
  const siteId = asId<SiteId>('site_1');

  it('omits unverified fields from the publishable projection', () => {
    const graph = new KnowledgeGraph(siteId);
    const created = graph.upsertEntity('Business', { name: 'Acme Roofing', description: 'Guess' }, crawl, {
      confidenceByField: { name: 0.95, description: 0.4 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const published = graph.publishableEntity(created.value.id);
    expect(published?.['name']).toBe('Acme Roofing');
    expect(published?.['description']).toBeUndefined();
  });

  it('includes the field once approved', () => {
    const graph = new KnowledgeGraph(siteId);
    const created = graph.upsertEntity('Business', { name: 'Acme', description: 'Roofers' }, crawl, {
      confidenceByField: { description: 0.4 },
    });
    if (!created.ok) throw new Error('setup failed');

    const fact = graph.getFact(created.value.id, 'description');
    if (!fact) throw new Error('no fact recorded');
    graph.replaceFact(created.value.id, 'description', approve(fact, 'usr_1'));

    expect(graph.publishableEntity(created.value.id)?.['description']).toBe('Roofers');
  });

  it('merges entities by dedupe key rather than duplicating them', () => {
    const graph = new KnowledgeGraph(siteId);
    graph.upsertEntity('Employee', { name: 'Melissa Doyle' }, crawl, { dedupeKey: 'melissa-doyle' });
    graph.upsertEntity('Employee', { name: 'Melissa Doyle', role: 'Estimator' }, typed, { dedupeKey: 'melissa-doyle' });

    const employees = graph.byType('Employee');
    expect(employees).toHaveLength(1);
    expect(employees[0]?.['role']).toBe('Estimator');
  });

  it('reports a review queue ordered by weakest confidence first', () => {
    const graph = new KnowledgeGraph(siteId);
    graph.upsertEntity('Business', { name: 'Acme', description: 'Maybe', industry: 'Unclear' }, crawl, {
      confidenceByField: { name: 0.95, description: 0.5, industry: 0.3 },
    });
    const queue = graph.reviewQueue();
    expect(queue.length).toBeGreaterThanOrEqual(2);
    expect(queue[0]?.confidence).toBeLessThanOrEqual(queue[1]?.confidence ?? 1);
  });

  it('round-trips through JSON', () => {
    const graph = new KnowledgeGraph(siteId);
    const created = graph.upsertEntity('Service', { name: 'Roof Replacement' }, crawl);
    if (!created.ok) throw new Error('setup failed');
    graph.relate(created.value.id, created.value.id, 'selfRef', 0.5);

    const restored = KnowledgeGraph.fromJSON(JSON.parse(JSON.stringify(graph.toJSON())));
    expect(restored.byType('Service')).toHaveLength(1);
    expect(restored.getFact(created.value.id, 'name')?.value).toBe('Roof Replacement');
    expect(restored.edges()).toHaveLength(1);
  });
});
