import { err } from '../core/errors.ts';
import { newId, type EntityId, type SiteId } from '../core/ids.ts';
import {
  effectiveValue, isPublishable, makeFact, mergeFact,
  type Fact, type SourceRef,
} from '../core/provenance.ts';
import { fail, ok, type Result } from '../core/result.ts';
import { ENTITY_TYPES, schemaFor, type Entity, type EntityType } from './entities.ts';

/**
 * The Business Knowledge Graph.
 *
 * Entities hold shape; Facts hold trust. Every field of every entity is
 * addressed by `entityId#fieldPath` and carries its own provenance, so the
 * review UI can show "we found 3 phone numbers, here's where each came from"
 * and the publisher can refuse to ship anything unapproved.
 *
 * Relationships are typed edges kept separate from entity bodies so that a
 * relationship discovered later (this employee works at that location) does
 * not require rewriting — and re-validating — the entity itself.
 */

export interface Relationship {
  from: string;
  to: string;
  /** worksAt, offers, locatedIn, authoredBy, partOf, servesArea, variantOf… */
  kind: string;
  confidence: number;
}

export interface GraphStats {
  entitiesByType: Partial<Record<EntityType, number>>;
  totalEntities: number;
  totalFacts: number;
  pendingReview: number;
  conflicts: number;
  publishable: number;
}

export class KnowledgeGraph {
  readonly siteId: SiteId;
  private entities = new Map<string, Entity>();
  private facts = new Map<string, Fact>();
  private relationships: Relationship[] = [];

  constructor(siteId: SiteId) {
    this.siteId = siteId;
  }

  private factKey(entityId: string, path: string) {
    return `${entityId}#${path}`;
  }

  /**
   * Insert or merge an entity. Fields arrive as plain values plus a shared
   * SourceRef; each becomes an individually-tracked Fact.
   */
  upsertEntity(
    type: EntityType,
    fields: Record<string, unknown>,
    source: SourceRef,
    opts: { id?: string; confidenceByField?: Record<string, number>; dedupeKey?: string } = {},
  ): Result<Entity> {
    if (!ENTITY_TYPES.includes(type)) {
      return fail(err('VALIDATION_FAILED', `unknown entity type "${type}"`));
    }

    const existingId = opts.id ?? (opts.dedupeKey ? this.findByDedupeKey(type, opts.dedupeKey) : undefined);
    const id = existingId ?? (newId('entity') as EntityId);
    const prior = this.entities.get(id);

    const merged: Entity = {
      ...(prior ?? { id, type, tags: [] }),
      ...fields,
      id,
      type,
      tags: prior?.tags ?? [],
    };

    const parsed = schemaFor(type).safeParse(merged);
    if (!parsed.success) {
      return fail(err('VALIDATION_FAILED', `invalid ${type}`, {
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }));
    }

    const entity = parsed.data as Entity;
    if (opts.dedupeKey) entity.dedupeKey = opts.dedupeKey;
    this.entities.set(id, entity);

    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === '') continue;
      this.recordFact(id, field, value, source, opts.confidenceByField?.[field]);
    }

    return ok(entity);
  }

  /** Record one observation of one field. Repeat observations merge. */
  recordFact(
    entityId: string,
    path: string,
    value: unknown,
    source: SourceRef,
    confidence?: number,
  ): Fact {
    const key = this.factKey(entityId, path);
    const incoming = makeFact(
      `${entityId}#${path}`,
      value,
      source,
      confidence !== undefined ? { confidence } : {},
    );
    const existing = this.facts.get(key);
    const next = existing ? mergeFact(existing, incoming) : incoming;
    this.facts.set(key, next);
    return next;
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  byType(type: EntityType): Entity[] {
    return [...this.entities.values()].filter((e) => e.type === type);
  }

  allEntities(): Entity[] {
    return [...this.entities.values()];
  }

  getFact(entityId: string, path: string): Fact | undefined {
    return this.facts.get(this.factKey(entityId, path));
  }

  factsFor(entityId: string): Fact[] {
    return [...this.facts.values()].filter((f) => f.path.startsWith(`${entityId}#`));
  }

  allFacts(): Fact[] {
    return [...this.facts.values()];
  }

  replaceFact(entityId: string, path: string, fact: Fact): void {
    this.facts.set(this.factKey(entityId, path), fact);
    const entity = this.entities.get(entityId);
    if (entity) {
      this.entities.set(entityId, { ...entity, [path]: effectiveValue(fact) });
    }
  }

  relate(from: string, to: string, kind: string, confidence = 0.8): Relationship {
    const rel: Relationship = { from, to, kind, confidence };
    const dup = this.relationships.find((r) => r.from === from && r.to === to && r.kind === kind);
    if (dup) {
      dup.confidence = Math.max(dup.confidence, confidence);
      return dup;
    }
    this.relationships.push(rel);
    return rel;
  }

  related(from: string, kind?: string): Entity[] {
    return this.relationships
      .filter((r) => r.from === from && (kind === undefined || r.kind === kind))
      .map((r) => this.entities.get(r.to))
      .filter((e): e is Entity => e !== undefined);
  }

  edges(): Relationship[] {
    return [...this.relationships];
  }

  private findByDedupeKey(type: EntityType, key: string): string | undefined {
    for (const e of this.entities.values()) {
      if (e.type === type && e.dedupeKey === key) return e.id;
    }
    return undefined;
  }

  /**
   * The projection published pages actually read. Fields whose Fact has not
   * cleared the publication gate are omitted entirely — a missing phone number
   * is always better than a wrong one.
   */
  publishableEntity(id: string): Entity | undefined {
    const entity = this.entities.get(id);
    if (!entity) return undefined;
    const out: Entity = { id: entity.id, type: entity.type, tags: entity.tags };
    for (const [field, value] of Object.entries(entity)) {
      if (['id', 'type', 'tags', 'dedupeKey'].includes(field)) continue;
      const fact = this.getFact(id, field);
      if (!fact) {
        // Structural defaults (empty arrays, booleans from schema defaults)
        // have no Fact; they carry no business claim, so they pass through.
        out[field] = value;
        continue;
      }
      if (isPublishable(fact)) out[field] = effectiveValue(fact);
    }
    return out;
  }

  /** Everything a human must resolve before the site can go live. */
  reviewQueue(): Fact[] {
    return this.allFacts()
      .filter((f) => !isPublishable(f) && f.approval !== 'rejected')
      .sort((a, b) => a.confidence - b.confidence);
  }

  /** Fields where two sources disagreed. Surfaced prominently in review. */
  conflicts(): Fact[] {
    return this.allFacts().filter((f) => (f.alternatives?.length ?? 0) > 0);
  }

  stats(): GraphStats {
    const entitiesByType: Partial<Record<EntityType, number>> = {};
    for (const e of this.entities.values()) {
      entitiesByType[e.type] = (entitiesByType[e.type] ?? 0) + 1;
    }
    const facts = this.allFacts();
    return {
      entitiesByType,
      totalEntities: this.entities.size,
      totalFacts: facts.length,
      pendingReview: facts.filter((f) => !isPublishable(f) && f.approval !== 'rejected').length,
      conflicts: this.conflicts().length,
      publishable: facts.filter(isPublishable).length,
    };
  }

  toJSON() {
    return {
      siteId: this.siteId,
      entities: this.allEntities(),
      facts: this.allFacts(),
      relationships: this.relationships,
    };
  }

  static fromJSON(data: ReturnType<KnowledgeGraph['toJSON']>): KnowledgeGraph {
    const graph = new KnowledgeGraph(data.siteId);
    for (const e of data.entities) graph.entities.set(e.id, e);
    for (const f of data.facts) {
      const [entityId, path] = f.path.split('#');
      graph.facts.set(graph.factKey(entityId as string, path ?? ''), f);
    }
    graph.relationships = [...data.relationships];
    return graph;
  }
}
