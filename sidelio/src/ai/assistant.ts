import type { Page } from '../blocks/page.ts';
import { validateBlock, type Block } from '../blocks/schema.ts';
import {
  createChangeSet, summarize, describeImpact,
  type ChangeSet, type ChangeWarning, type Operation, type ResourceRef,
} from '../core/changeset.ts';
import { err } from '../core/errors.ts';
import type { SiteId, UserId } from '../core/ids.ts';
import { fail, ok, type Result } from '../core/result.ts';
import { auditContrast, type BrandKit } from '../design/brand-kit.ts';
import type { ProviderRegistry, GenerationContext, SiteContext } from './provider.ts';

/**
 * Sidelio Site Assistant.
 *
 * Turns "change all phone numbers to 902-555-1234" into a reviewable change
 * set. The key architectural decision: **high-risk bulk edits are handled
 * deterministically, not by a model.** A find-and-replace across 40 pages must
 * be exact and enumerable; asking a model to rewrite those pages would be
 * slower, more expensive and occasionally wrong. Models are used where they
 * add real value — open-ended authoring, restructuring, tone — and even then
 * the result is a change set the user previews before anything is applied.
 *
 * Every path ends the same way: PREVIEW → APPLY → CANCEL, with version history.
 */

export interface AssistantSiteState {
  siteId: SiteId;
  pages: Page[];
  brandKit: BrandKit;
  siteContext: SiteContext;
}

export interface AssistantRequest {
  intent: string;
  actorId: UserId;
  state: AssistantSiteState;
  /** Restricts the change to one page when the user is editing it. */
  scopePageId?: string;
}

export interface AssistantPlan {
  changeSet: ChangeSet;
  /** Rendered lines for the WHAT WILL CHANGE panel. */
  impact: string[];
  /** How the plan was produced — surfaced so users know what happened. */
  strategy: 'deterministic' | 'model' | 'clarification_needed';
  explanation: string;
  /** Set when the assistant needs an answer before it can build a plan. */
  question?: string;
}

/* ------------------------------------------------------------------ */
/* Deterministic intent handlers                                       */
/* ------------------------------------------------------------------ */

interface HandlerContext {
  request: AssistantRequest;
  match: RegExpExecArray;
}

interface IntentHandler {
  name: string;
  pattern: RegExp;
  build(ctx: HandlerContext): Result<{ operations: Operation[]; explanation: string; warnings?: ChangeWarning[] }>;
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Walk a block's props, applying a transform to every string leaf. */
function mapStrings(
  value: unknown,
  path: string,
  visit: (text: string, path: string) => string | null,
  out: Array<{ path: string; before: string; after: string }>,
): void {
  if (typeof value === 'string') {
    const next = visit(value, path);
    if (next !== null && next !== value) out.push({ path, before: value, after: next });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => mapStrings(item, `${path}.${i}`, visit, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      mapStrings(child, `${path}.${key}`, visit, out);
    }
  }
}

function pageRef(page: Page): ResourceRef {
  return { type: 'page', id: page.id, label: page.title };
}

/** Build `set` operations for every string replacement across the site. */
function replaceAcrossPages(
  request: AssistantRequest,
  visit: (text: string, path: string) => string | null,
): Operation[] {
  const ops: Operation[] = [];
  const pages = request.scopePageId
    ? request.state.pages.filter((p) => p.id === request.scopePageId)
    : request.state.pages;

  for (const page of pages) {
    page.blocks.forEach((blockValue, index) => {
      const changes: Array<{ path: string; before: string; after: string }> = [];
      mapStrings(blockValue.props, `blocks.${index}.props`, visit, changes);
      for (const change of changes) {
        ops.push({ op: 'set', resource: pageRef(page), path: change.path, before: change.before, after: change.after });
      }
    });

    const seoChanges: Array<{ path: string; before: string; after: string }> = [];
    mapStrings(page.seo, 'seo', visit, seoChanges);
    for (const change of seoChanges) {
      ops.push({ op: 'set', resource: pageRef(page), path: change.path, before: change.before, after: change.after });
    }
  }
  return ops;
}

const HANDLERS: IntentHandler[] = [
  {
    name: 'replace_phone',
    pattern: /(?:change|update|replace|set)\s+(?:all\s+)?(?:the\s+)?phone(?:\s+numbers?)?\s+(?:to|with)\s+([\d\s().+-]{7,})/i,
    build({ request, match }) {
      const target = (match[1] ?? '').trim();
      const digits = target.replace(/\D/g, '');
      if (digits.length < 10) {
        return fail(err('VALIDATION_FAILED', 'phone number is too short', {
          userMessage: `"${target}" does not look like a complete phone number.`,
        }));
      }
      const formatted = digits.length === 11 && digits.startsWith('1')
        ? formatNanp(digits.slice(1))
        : formatNanp(digits);

      const ops = replaceAcrossPages(request, (text) => {
        if (text.startsWith('tel:')) return `tel:${digits}`;
        return text.replace(PHONE_RE, formatted);
      });

      return ok({
        operations: ops,
        explanation: `Replaces every phone number on the site with ${formatted}, including tel: links.`,
      });
    },
  },

  {
    name: 'replace_email',
    pattern: /(?:change|update|replace|set)\s+(?:all\s+)?(?:the\s+)?(?:emails?|e-mails?)(?:\s+addresses?)?\s+(?:to|with)\s+(\S+@\S+)/i,
    build({ request, match }) {
      const target = (match[1] ?? '').trim().replace(/[.,;]$/, '');
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(target)) {
        return fail(err('VALIDATION_FAILED', 'invalid email address', {
          userMessage: `"${target}" does not look like a valid email address.`,
        }));
      }
      const ops = replaceAcrossPages(request, (text) => {
        if (text.startsWith('mailto:')) return `mailto:${target}`;
        return text.replace(EMAIL_RE, target);
      });
      return ok({
        operations: ops,
        explanation: `Replaces every email address on the site with ${target}, including mailto: links.`,
      });
    },
  },

  {
    name: 'find_replace_text',
    pattern: /(?:change|replace)\s+(?:all\s+)?["“']([^"”']+)["”']\s+(?:to|with)\s+["“']([^"”']+)["”']/i,
    build({ request, match }) {
      const from = match[1] as string;
      const to = match[2] as string;
      const ops = replaceAcrossPages(request, (text) =>
        text.includes(from) ? text.split(from).join(to) : null);
      return ok({
        operations: ops,
        explanation: `Replaces "${from}" with "${to}" everywhere it appears.`,
      });
    },
  },

  {
    name: 'set_brand_color',
    pattern: /(?:use|set|change)\s+(?:our\s+|the\s+)?(?:brand\s+)?(primary|secondary|accent)?\s*colou?r\s*(?:to\s+)?(#[0-9a-f]{3,8}|\b[a-z]+\b)/i,
    build({ request, match }) {
      const role = (match[1] ?? 'primary').toLowerCase();
      const raw = (match[2] ?? '').trim();
      const hex = normalizeColor(raw);
      if (!hex) {
        return fail(err('VALIDATION_FAILED', `unrecognized colour "${raw}"`, {
          userMessage: `I couldn't work out what colour "${raw}" is. Try a hex value like #2a9d8f.`,
        }));
      }

      const before = request.state.brandKit.colors[role as 'primary'] ?? null;
      const nextKit: BrandKit = {
        ...request.state.brandKit,
        colors: { ...request.state.brandKit.colors, [role]: hex },
      };

      // An illegible label blocks the change outright; a component that is
      // merely hard to distinguish from its background is a warning, since a
      // custom border or shadow may already resolve it.
      const warnings: ChangeWarning[] = auditContrast(nextKit).map((issue) => ({
        severity: issue.kind === 'text' && issue.level === 'fail' ? 'blocking' : 'warning',
        code: 'contrast_below_wcag',
        message: issue.kind === 'text'
          ? `${issue.token} would have a contrast ratio of ${issue.ratio}:1 (${issue.level}). WCAG AA needs 4.5:1 for text.`
          : `${issue.token} would have a contrast ratio of ${issue.ratio}:1. WCAG needs 3:1 so the component is distinguishable.`,
      }));

      return ok({
        operations: [{
          op: 'set',
          resource: { type: 'brand', id: request.state.siteId, label: 'Brand kit' },
          path: `colors.${role}`,
          before,
          after: hex,
        }],
        explanation: `Sets the ${role} brand colour to ${hex}. Every button, link and accent that uses the ${role} token updates automatically.`,
        warnings,
      });
    },
  },

  {
    name: 'add_block',
    pattern: /add\s+(?:a\s+|an\s+)?(testimonials?|faq|team|contact|gallery|cta|pricing|stats|services?|map|form|banner|video)\s*(?:section|block)?\s*(?:(below|above|after|before)\s+(?:the\s+)?(\w+))?/i,
    build({ request, match }) {
      const rawType = (match[1] ?? '').toLowerCase().replace(/s$/, '');
      const typeMap: Record<string, Block['type']> = {
        testimonial: 'testimonials', faq: 'faq', team: 'team', contact: 'contact',
        gallery: 'gallery', cta: 'cta', pricing: 'pricing', stat: 'stats',
        service: 'services', map: 'map', form: 'form', banner: 'banner', video: 'video',
      };
      const blockType = typeMap[rawType];
      if (!blockType) {
        return fail(err('AI_PLAN_NOT_APPLICABLE', `unknown block type "${rawType}"`));
      }

      const page = request.scopePageId
        ? request.state.pages.find((p) => p.id === request.scopePageId)
        : request.state.pages.find((p) => p.path === '/');
      if (!page) {
        return fail(err('NOT_FOUND', 'no page in scope', {
          userMessage: 'Open the page you want to change first, then ask again.',
        }));
      }

      const relation = (match[2] ?? 'below').toLowerCase();
      const anchorName = (match[3] ?? '').toLowerCase();
      let index = page.blocks.length;
      if (anchorName) {
        const anchorIdx = page.blocks.findIndex((b) => b.type.includes(anchorName));
        if (anchorIdx !== -1) {
          index = relation === 'above' || relation === 'before' ? anchorIdx : anchorIdx + 1;
        }
      }

      const newBlock = defaultBlock(blockType);
      const issues = validateBlock(newBlock);
      if (issues.length > 0) {
        return fail(err('VALIDATION_FAILED', `generated ${blockType} block is invalid`, {
          details: issues.map((i) => ({ path: i.path, message: i.message })),
        }));
      }

      return ok({
        operations: [{
          op: 'insert',
          resource: pageRef(page),
          path: 'blocks',
          index,
          after: newBlock,
        }],
        explanation: `Adds a ${blockType.replace('_', ' ')} section to "${page.title}"${anchorName ? ` ${relation} the ${anchorName} section` : ''}.`,
      });
    },
  },

  {
    name: 'hide_block',
    pattern: /(?:hide|remove|delete)\s+(?:the\s+)?(\w+)\s*(?:section|block)/i,
    build({ request, match }) {
      const target = (match[1] ?? '').toLowerCase();
      const pages = request.scopePageId
        ? request.state.pages.filter((p) => p.id === request.scopePageId)
        : request.state.pages;

      const ops: Operation[] = [];
      for (const page of pages) {
        page.blocks.forEach((b, i) => {
          if (!b.type.includes(target)) return;
          ops.push({ op: 'remove', resource: pageRef(page), path: 'blocks', index: i, before: b });
        });
      }
      if (ops.length === 0) {
        return fail(err('AI_PLAN_NOT_APPLICABLE', `no ${target} section found`, {
          userMessage: `I couldn't find a ${target} section to remove.`,
        }));
      }
      return ok({
        operations: ops,
        explanation: `Removes ${ops.length} ${target} section(s).`,
        warnings: [{
          severity: 'warning',
          code: 'content_removal',
          message: 'This removes content. You can undo it from version history after applying.',
        }],
      });
    },
  },

  {
    name: 'noindex_page',
    pattern: /(?:hide|exclude)\s+(?:this\s+page|the\s+(\S+)\s+page)\s+from\s+(?:google|search)/i,
    build({ request, match }) {
      const named = match[1]?.toLowerCase();
      const page = named
        ? request.state.pages.find((p) => p.title.toLowerCase().includes(named) || p.path.includes(named))
        : request.state.pages.find((p) => p.id === request.scopePageId);
      if (!page) {
        return fail(err('NOT_FOUND', 'page not found', { userMessage: 'I could not find that page.' }));
      }
      return ok({
        operations: [{
          op: 'set', resource: pageRef(page), path: 'seo.noindex', before: page.seo.noindex, after: true,
        }],
        explanation: `Marks "${page.title}" as noindex so search engines exclude it.`,
      });
    },
  },
];

function formatNanp(digits: string): string {
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

const NAMED_COLORS: Record<string, string> = {
  red: '#dc2626', blue: '#2563eb', green: '#16a34a', teal: '#0d9488',
  orange: '#ea580c', purple: '#7c3aed', pink: '#db2777', yellow: '#eab308',
  black: '#0f172a', white: '#ffffff', grey: '#64748b', gray: '#64748b',
  navy: '#1e3a5f', gold: '#d4a017', burgundy: '#7f1d3a',
};

function normalizeColor(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed.slice(1).split('').map((c) => c + c).join('')}`;
  }
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  return NAMED_COLORS[trimmed] ?? null;
}

function defaultBlock(type: Block['type']): Block {
  const defaults: Partial<Record<Block['type'], Record<string, unknown>>> = {
    testimonials: { heading: 'What our customers say', source: 'collection', items: [], layout: 'cards', limit: 6 },
    faq: { heading: 'Frequently asked questions', source: 'collection', items: [], layout: 'accordion', emitSchema: true },
    team: { heading: 'Meet the team', source: 'collection', members: [], columns: 3, photoShape: 'circle' },
    contact: { heading: 'Get in touch', showPhone: true, showEmail: true, showAddress: true, showHours: true },
    gallery: { heading: 'Gallery', images: [], layout: 'grid', columns: 3, lightbox: true },
    cta: { heading: 'Ready to get started?', buttons: [{ label: 'Contact us', href: '/contact', style: 'primary', newTab: false }], layout: 'banner' },
    pricing: { heading: 'Pricing', tiers: [] },
    stats: { heading: 'By the numbers', items: [] },
    services: { heading: 'What we do', source: 'collection', items: [], columns: 3, layout: 'cards' },
    map: { zoom: 14, height: '400px', showDirectionsLink: true },
    form: { formId: 'contact', submitLabel: 'Send', successMessage: 'Thanks — we\'ll be in touch shortly.', layout: 'stacked' },
    banner: { message: 'Announcement', dismissible: true, tone: 'info', position: 'top' },
    video: { url: '', autoplay: false, loop: false, muted: true },
  };

  return {
    id: `blk_${Math.random().toString(36).slice(2, 12)}`,
    type,
    props: defaults[type] ?? {},
    style: { scheme: 'inherit', animation: 'none' },
    visibility: { hiddenOn: [], requiresAuth: false },
    locked: false,
  };
}

/* ------------------------------------------------------------------ */
/* Assistant                                                           */
/* ------------------------------------------------------------------ */

/** JSON schema the model must satisfy when planning an open-ended edit. */
export const PLAN_SCHEMA = {
  type: 'object',
  required: ['operations', 'explanation'],
  properties: {
    explanation: { type: 'string' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['op', 'resourceType', 'resourceId'],
        properties: {
          op: { type: 'string', enum: ['set', 'insert', 'remove', 'move'] },
          resourceType: { type: 'string', enum: ['page', 'brand', 'seo'] },
          resourceId: { type: 'string' },
          path: { type: 'string' },
          index: { type: 'number' },
          value: {},
        },
      },
    },
  },
} as const;

export class SiteAssistant {
  private readonly providers: ProviderRegistry;

  constructor(providers: ProviderRegistry) {
    this.providers = providers;
  }

  /** Try deterministic handlers first; fall back to the model. */
  async plan(request: AssistantRequest): Promise<Result<AssistantPlan>> {
    const deterministic = this.planDeterministic(request);
    if (deterministic) return deterministic;
    return this.planWithModel(request);
  }

  planDeterministic(request: AssistantRequest): Result<AssistantPlan> | null {
    for (const handler of HANDLERS) {
      const match = handler.pattern.exec(request.intent);
      if (!match) continue;

      const built = handler.build({ request, match });
      if (!built.ok) return built;

      if (built.value.operations.length === 0) {
        return fail(err('AI_PLAN_NOT_APPLICABLE', `${handler.name} matched but changed nothing`, {
          userMessage: 'Nothing on the site matches that — no changes are needed.',
        }));
      }

      const changeSet = createChangeSet({
        siteId: request.state.siteId,
        origin: 'ai_assistant',
        title: request.intent.slice(0, 120),
        intent: request.intent,
        operations: built.value.operations,
        createdBy: request.actorId,
        ...(built.value.warnings ? { warnings: built.value.warnings } : {}),
      });

      return ok({
        changeSet,
        impact: describeImpact(summarize(changeSet)),
        strategy: 'deterministic',
        explanation: built.value.explanation,
      });
    }
    return null;
  }

  private async planWithModel(request: AssistantRequest): Promise<Result<AssistantPlan>> {
    const ctx: GenerationContext = {
      orgId: '',
      siteId: request.state.siteId,
      userId: request.actorId,
      siteContext: request.state.siteContext,
      requestId: `assist_${Date.now()}`,
    };

    const response = await this.providers.generateText({
      system: buildSystemPrompt(request.state),
      prompt: buildPlanPrompt(request),
      jsonSchema: PLAN_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 4096,
      temperature: 0.2,
    }, ctx);

    if (!response.ok) return response;

    const parsed = parseModelPlan(response.value.json, request);
    if (!parsed.ok) return parsed;

    const changeSet = createChangeSet({
      siteId: request.state.siteId,
      origin: 'ai_assistant',
      title: request.intent.slice(0, 120),
      intent: request.intent,
      operations: parsed.value.operations,
      createdBy: request.actorId,
      warnings: parsed.value.operations.length > 20
        ? [{
            severity: 'warning',
            code: 'large_change',
            message: `This affects ${parsed.value.operations.length} items. Review the preview carefully before applying.`,
          }]
        : [],
    });

    return ok({
      changeSet,
      impact: describeImpact(summarize(changeSet)),
      strategy: 'model',
      explanation: parsed.value.explanation,
    });
  }
}

interface ModelOperation {
  op: string;
  resourceType: string;
  resourceId: string;
  path?: string;
  index?: number;
  value?: unknown;
}

/**
 * Translate the model's plan into real operations, rejecting anything that
 * references a resource the actor is not editing. A model must never be able
 * to widen its own blast radius.
 */
function parseModelPlan(
  json: unknown,
  request: AssistantRequest,
): Result<{ operations: Operation[]; explanation: string }> {
  if (!json || typeof json !== 'object') {
    return fail(err('AI_PLAN_NOT_APPLICABLE', 'model returned no plan', {
      userMessage: 'I could not work out how to make that change. Try describing it differently.',
    }));
  }
  const plan = json as { operations?: unknown; explanation?: unknown };
  const rawOps = Array.isArray(plan.operations) ? (plan.operations as ModelOperation[]) : [];
  if (rawOps.length === 0) {
    return fail(err('AI_PLAN_NOT_APPLICABLE', 'model produced an empty plan', {
      userMessage: 'I could not work out how to make that change. Try describing it differently.',
    }));
  }

  const pagesById = new Map(request.state.pages.map((p) => [p.id, p]));
  const operations: Operation[] = [];

  for (const raw of rawOps) {
    if (raw.resourceType === 'page' || raw.resourceType === 'seo') {
      const page = pagesById.get(raw.resourceId);
      if (!page) {
        return fail(err('AI_PLAN_NOT_APPLICABLE', `plan references unknown page ${raw.resourceId}`, {
          userMessage: 'The assistant referred to a page that no longer exists. Please try again.',
        }));
      }
      if (request.scopePageId && page.id !== request.scopePageId) {
        return fail(err('FORBIDDEN', 'plan reaches outside the current page scope', {
          userMessage: 'That change would affect other pages. Ask again from the site level to allow it.',
        }));
      }
      const ref = pageRef(page);
      const built = buildOperation(raw, ref, page);
      if (!built.ok) return built;
      operations.push(built.value);
    } else if (raw.resourceType === 'brand') {
      const ref: ResourceRef = { type: 'brand', id: request.state.siteId, label: 'Brand kit' };
      operations.push({
        op: 'set',
        resource: ref,
        path: raw.path ?? '',
        before: readByPath(request.state.brandKit, raw.path ?? ''),
        after: raw.value,
      });
    } else {
      return fail(err('AI_PLAN_NOT_APPLICABLE', `unsupported resource type ${raw.resourceType}`));
    }
  }

  return ok({
    operations,
    explanation: typeof plan.explanation === 'string' ? plan.explanation : 'Applies the requested change.',
  });
}

function buildOperation(raw: ModelOperation, ref: ResourceRef, page: Page): Result<Operation> {
  switch (raw.op) {
    case 'set':
      return ok({ op: 'set', resource: ref, path: raw.path ?? '', before: readByPath(page, raw.path ?? ''), after: raw.value });
    case 'insert':
      return ok({ op: 'insert', resource: ref, path: raw.path ?? 'blocks', index: raw.index ?? page.blocks.length, after: raw.value });
    case 'remove': {
      const index = raw.index ?? -1;
      const before = page.blocks[index];
      if (before === undefined) {
        return fail(err('AI_PLAN_NOT_APPLICABLE', `remove index ${index} is out of range`));
      }
      return ok({ op: 'remove', resource: ref, path: raw.path ?? 'blocks', index, before });
    }
    case 'move':
      return ok({
        op: 'move', resource: ref, path: raw.path ?? 'blocks',
        fromIndex: raw.index ?? 0, toIndex: typeof raw.value === 'number' ? raw.value : 0,
      });
    default:
      return fail(err('AI_PLAN_NOT_APPLICABLE', `unsupported operation "${raw.op}"`));
  }
}

function readByPath(doc: unknown, path: string): unknown {
  if (!path) return undefined;
  let cursor: unknown = doc;
  for (const seg of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = Array.isArray(cursor)
      ? cursor[Number(seg)]
      : (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function buildSystemPrompt(state: AssistantSiteState): string {
  const c = state.siteContext;
  return [
    'You are the Sidelio Site Assistant. You edit a website by emitting a plan of operations.',
    '',
    'Rules:',
    '- Only reference page ids that appear in the page list you are given.',
    '- Never invent business facts (phone numbers, addresses, prices, credentials). If a fact is needed and absent, leave a placeholder and say so in your explanation.',
    '- Use brand tokens, never raw colour values, inside block styles.',
    '- Prefer the smallest set of operations that achieves the request.',
    '',
    'Business context:',
    `- Name: ${c.businessName ?? 'unknown'}`,
    `- Industry: ${c.industry ?? 'unknown'}`,
    `- Voice: ${c.brandVoice ?? 'professional, plain-spoken'}`,
    `- Locale: ${c.locale ?? 'en'}`,
    c.businessDescription ? `- About: ${c.businessDescription}` : '',
  ].filter(Boolean).join('\n');
}

function buildPlanPrompt(request: AssistantRequest): string {
  const pages = request.state.pages.map((p) => ({
    id: p.id,
    path: p.path,
    title: p.title,
    blocks: p.blocks.map((b, i) => ({ index: i, type: b.type, id: b.id })),
  }));

  return [
    `Request: ${request.intent}`,
    '',
    request.scopePageId ? `Scope: page ${request.scopePageId} only.` : 'Scope: the whole site.',
    '',
    'Pages:',
    JSON.stringify(pages, null, 2),
  ].join('\n');
}
