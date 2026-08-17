/**
 * Automations.
 *
 * A trigger fires, conditions are checked, actions run. The whole point is
 * that a small business can wire "when someone books, tag them and email me"
 * without writing code — which means the engine has to be safe by
 * construction, because nobody is reviewing what they built.
 *
 * The failure modes this module is designed around are the ones that actually
 * bite in production:
 *
 *  - **Loops.** An automation that tags a contact, triggered by a contact
 *    being tagged, will run until something stops it. Every run carries a
 *    causation chain and refuses to re-enter an automation already in it.
 *  - **Duplicate sends.** Retries and at-least-once delivery mean the same
 *    trigger arrives twice. Runs are keyed so the second is a no-op.
 *  - **Runaway volume.** A bulk import firing ten thousand welcome emails is
 *    a reputational incident. Automations carry rate limits and per-contact
 *    re-entry windows.
 *  - **Silent failure.** An action that quietly fails leaves a business
 *    believing customers were contacted. Every step records its outcome and a
 *    failed run is visible, not swallowed.
 */

import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { SiteId } from '../core/ids.ts';

export type TriggerKind =
  | 'form_submitted' | 'booking_created' | 'booking_cancelled' | 'booking_upcoming'
  | 'order_placed' | 'order_fulfilled' | 'order_refunded' | 'cart_abandoned'
  | 'event_registered' | 'contact_created' | 'contact_tagged' | 'deal_stage_changed'
  | 'schedule';

export type ConditionOperator =
  | 'equals' | 'not_equals' | 'contains' | 'not_contains'
  | 'greater_than' | 'less_than' | 'is_set' | 'is_not_set' | 'in';

export interface Condition {
  /** Dotted path into the trigger payload: "order.total", "contact.tags". */
  path: string;
  operator: ConditionOperator;
  value?: unknown;
}

export type Action =
  | { kind: 'send_email'; to: 'contact' | 'staff'; templateId: string; subject?: string }
  | { kind: 'send_sms'; to: 'contact'; templateId: string }
  | { kind: 'add_tag'; tag: string }
  | { kind: 'remove_tag'; tag: string }
  | { kind: 'set_property'; key: string; value: string }
  | { kind: 'create_deal'; title: string; stageId: string }
  | { kind: 'move_deal'; stageId: string }
  | { kind: 'notify_webhook'; url: string; secretRef?: string }
  | { kind: 'create_task'; title: string; assigneeId?: string; dueInDays?: number }
  | { kind: 'wait'; minutes: number };

export interface Automation {
  id: string;
  siteId: SiteId;
  name: string;
  trigger: { kind: TriggerKind; /** schedule only */ cron?: string; formId?: string };
  conditions: Condition[];
  /** All conditions must hold, or any of them. */
  conditionMode: 'all' | 'any';
  actions: Action[];
  enabled: boolean;
  /** Do not run again for the same contact inside this window. */
  reentryWindowMinutes?: number;
  /** Hard ceiling on runs per hour for the whole automation. */
  maxRunsPerHour?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StepResult {
  action: Action;
  status: 'ok' | 'skipped' | 'failed';
  detail?: string;
}

export interface AutomationRun {
  id: string;
  siteId: SiteId;
  automationId: string;
  triggerKind: TriggerKind;
  /** Same trigger delivered twice carries the same key. */
  idempotencyKey: string;
  contactId?: string;
  status: 'completed' | 'failed' | 'skipped' | 'waiting';
  steps: StepResult[];
  /** Automations already in this causation chain. */
  causedBy: string[];
  reason?: string;
  startedAt: string;
  finishedAt?: string;
}

/* ------------------------------------------------------------------ */
/* Conditions                                                          */
/* ------------------------------------------------------------------ */

/** Read a dotted path out of a payload without evaluating anything. */
export function readPath(payload: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node) && /^\d+$/.test(key)) return node[Number(key)];
    if (typeof node === 'object') return (node as Record<string, unknown>)[key];
    return undefined;
  }, payload);
}

export function evaluateCondition(condition: Condition, payload: unknown): boolean {
  const actual = readPath(payload, condition.path);
  const expected = condition.value;

  switch (condition.operator) {
    case 'is_set':
      return actual !== undefined && actual !== null && actual !== '';
    case 'is_not_set':
      return actual === undefined || actual === null || actual === '';
    case 'equals':
      return looseEquals(actual, expected);
    case 'not_equals':
      return !looseEquals(actual, expected);
    case 'contains':
      if (Array.isArray(actual)) return actual.some((v) => looseEquals(v, expected));
      return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'not_contains':
      if (Array.isArray(actual)) return !actual.some((v) => looseEquals(v, expected));
      return !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'greater_than':
      return numeric(actual) > numeric(expected);
    case 'less_than':
      return numeric(actual) < numeric(expected);
    case 'in':
      return Array.isArray(expected) && expected.some((v) => looseEquals(actual, v));
    default:
      return false;
  }
}

/**
 * Compare a form value to a configured one.
 *
 * Values arriving from a form are strings; a merchant comparing against the
 * number 5 means "the same number". Strict equality here would make every
 * numeric condition silently false, which is worse than lenient comparison.
 */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return String(a) === String(b);
  }
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') {
    return na === nb;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function numeric(value: unknown): number {
  const n = Number(value);
  // NaN compares false against everything, so an unparseable value simply
  // fails the condition rather than throwing mid-run.
  return Number.isFinite(n) ? n : Number.NaN;
}

export function conditionsPass(automation: Automation, payload: unknown): boolean {
  if (automation.conditions.length === 0) return true;
  const results = automation.conditions.map((c) => evaluateCondition(c, payload));
  return automation.conditionMode === 'any' ? results.some(Boolean) : results.every(Boolean);
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export interface ActionContext {
  siteId: SiteId;
  payload: Record<string, unknown>;
  contactId?: string;
  now: Date;
}

export type ActionHandler = (action: Action, ctx: ActionContext) => Promise<StepResult> | StepResult;

export interface ExecuteInput {
  automation: Automation;
  triggerKind: TriggerKind;
  payload: Record<string, unknown>;
  contactId?: string;
  idempotencyKey: string;
  /** Automations already in this chain, to stop loops. */
  causedBy?: string[];
  /** Runs of this automation in the last hour. */
  recentRunCount?: number;
  /** When this automation last ran for this contact. */
  lastRunForContactAt?: string;
  handler: ActionHandler;
  now: Date;
  makeId: (prefix: string) => string;
}

export const MAX_CHAIN_DEPTH = 5;

/**
 * Run one automation against one trigger.
 *
 * Every guard produces a recorded `skipped` run rather than silence, because a
 * business asking "why didn't my automation fire?" needs an answer, and the
 * absence of a run tells them nothing.
 */
export async function executeAutomation(input: ExecuteInput): Promise<AutomationRun> {
  const { automation, now } = input;
  const causedBy = input.causedBy ?? [];

  const run: AutomationRun = {
    id: input.makeId('run'),
    siteId: automation.siteId,
    automationId: automation.id,
    triggerKind: input.triggerKind,
    idempotencyKey: input.idempotencyKey,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    status: 'completed',
    steps: [],
    causedBy,
    startedAt: now.toISOString(),
  };

  const skip = (reason: string): AutomationRun =>
    ({ ...run, status: 'skipped', reason, finishedAt: now.toISOString() });

  if (!automation.enabled) return skip('the automation is turned off');
  if (automation.trigger.kind !== input.triggerKind) return skip('trigger does not match');

  // An automation that tags a contact, triggered by tagging, runs forever.
  if (causedBy.includes(automation.id)) {
    return skip(`stopped a loop: ${automation.name} is already running in this chain`);
  }
  if (causedBy.length >= MAX_CHAIN_DEPTH) {
    return skip(`chain is ${causedBy.length} automations deep, which is the limit`);
  }

  if (automation.maxRunsPerHour !== undefined
    && (input.recentRunCount ?? 0) >= automation.maxRunsPerHour) {
    // A bulk import firing ten thousand welcome emails is a reputational
    // incident, not a busy afternoon.
    return skip(`rate limit reached: ${automation.maxRunsPerHour} runs in the last hour`);
  }

  if (automation.reentryWindowMinutes && input.lastRunForContactAt) {
    const since = now.getTime() - Date.parse(input.lastRunForContactAt);
    if (since < automation.reentryWindowMinutes * 60000) {
      return skip(`this contact was already run through ${automation.name} recently`);
    }
  }

  if (!conditionsPass(automation, input.payload)) return skip('conditions did not match');

  const ctx: ActionContext = {
    siteId: automation.siteId,
    payload: input.payload,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    now,
  };

  for (const action of automation.actions) {
    if (action.kind === 'wait') {
      // A wait suspends the run; the scheduler resumes it. Recording it as
      // `waiting` rather than plunging on is what makes drip sequences work.
      run.steps.push({ action, status: 'ok', detail: `waiting ${action.minutes} minutes` });
      return { ...run, status: 'waiting', finishedAt: now.toISOString() };
    }
    try {
      const result = await handlerWithGuard(input.handler, action, ctx);
      run.steps.push(result);
      if (result.status === 'failed') {
        // Stop on failure: later steps usually assume the earlier ones ran,
        // and sending step three of a sequence after step one failed is worse
        // than sending nothing.
        return { ...run, status: 'failed', reason: result.detail ?? 'an action failed', finishedAt: now.toISOString() };
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      run.steps.push({ action, status: 'failed', detail });
      return { ...run, status: 'failed', reason: detail, finishedAt: now.toISOString() };
    }
  }

  return { ...run, finishedAt: now.toISOString() };
}

async function handlerWithGuard(handler: ActionHandler, action: Action, ctx: ActionContext): Promise<StepResult> {
  const result = await handler(action, ctx);
  // A handler that returns nothing has done something unknown; treating that
  // as success is how silent failure gets in.
  if (!result || typeof result.status !== 'string') {
    return { action, status: 'failed', detail: 'the action handler returned no outcome' };
  }
  return result;
}

/**
 * Run every automation matching a trigger.
 *
 * Idempotent on the key: a redelivered trigger returns the runs already
 * recorded rather than repeating their side effects.
 */
export async function dispatch(input: {
  automations: Automation[];
  triggerKind: TriggerKind;
  payload: Record<string, unknown>;
  contactId?: string;
  idempotencyKey: string;
  existingRuns: AutomationRun[];
  causedBy?: string[];
  handler: ActionHandler;
  now: Date;
  makeId: (prefix: string) => string;
}): Promise<AutomationRun[]> {
  const already = input.existingRuns.filter((r) => r.idempotencyKey === input.idempotencyKey);
  if (already.length > 0) return already;

  const hourAgo = input.now.getTime() - 3600000;
  const out: AutomationRun[] = [];

  for (const automation of input.automations) {
    if (automation.trigger.kind !== input.triggerKind) continue;
    if (automation.trigger.formId && input.payload['formId'] !== automation.trigger.formId) continue;

    const recentRunCount = input.existingRuns
      .filter((r) => r.automationId === automation.id && Date.parse(r.startedAt) >= hourAgo).length;
    const lastForContact = input.contactId
      ? input.existingRuns
        .filter((r) => r.automationId === automation.id && r.contactId === input.contactId)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .pop()?.startedAt
      : undefined;

    out.push(await executeAutomation({
      automation,
      triggerKind: input.triggerKind,
      payload: input.payload,
      ...(input.contactId ? { contactId: input.contactId } : {}),
      idempotencyKey: input.idempotencyKey,
      ...(input.causedBy ? { causedBy: input.causedBy } : {}),
      recentRunCount,
      ...(lastForContact ? { lastRunForContactAt: lastForContact } : {}),
      handler: input.handler,
      now: input.now,
      makeId: input.makeId,
    }));
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** Hosts an automation webhook must never be pointed at. */
const BLOCKED_HOST = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.internal$|.*\.local$)/i;

export function validateAutomation(automation: Automation): Result<Automation> {
  if (automation.actions.length === 0) {
    return fail(err('VALIDATION_FAILED', 'an automation needs at least one action'));
  }
  if (automation.trigger.kind === 'schedule' && !automation.trigger.cron) {
    return fail(err('VALIDATION_FAILED', 'a scheduled automation needs a schedule'));
  }

  for (const condition of automation.conditions) {
    if (!/^[\w]+(\.[\w]+)*$/.test(condition.path)) {
      return fail(err('VALIDATION_FAILED', `"${condition.path}" is not a readable field path`));
    }
    if (condition.operator === 'in' && !Array.isArray(condition.value)) {
      return fail(err('VALIDATION_FAILED', `the "in" condition on ${condition.path} needs a list of values`));
    }
  }

  for (const action of automation.actions) {
    if (action.kind === 'notify_webhook') {
      let url: URL;
      try { url = new URL(action.url); }
      catch { return fail(err('VALIDATION_FAILED', `"${action.url}" is not a valid webhook URL`)); }
      if (url.protocol !== 'https:') {
        // A webhook carries customer data off the platform; plaintext is not
        // an option the merchant should be able to choose by accident.
        return fail(err('VALIDATION_FAILED', 'webhooks must use https'));
      }
      if (BLOCKED_HOST.test(url.hostname)) {
        // Otherwise an automation is a request forgery primitive pointed at
        // the platform's own network.
        return fail(err('VALIDATION_FAILED', 'webhooks cannot target internal addresses'));
      }
    }
    if (action.kind === 'wait' && (!Number.isInteger(action.minutes) || action.minutes <= 0)) {
      return fail(err('VALIDATION_FAILED', 'a wait must be a positive whole number of minutes'));
    }
    if (action.kind === 'add_tag' && !action.tag.trim()) {
      return fail(err('VALIDATION_FAILED', 'a tag action needs a tag'));
    }
  }

  // A tag action on a tag trigger is the classic self-triggering loop. The
  // chain guard catches it at runtime; catching it at save time explains it.
  if (automation.trigger.kind === 'contact_tagged') {
    const tagged = automation.actions.find((a) => a.kind === 'add_tag');
    if (tagged) {
      return fail(err('VALIDATION_FAILED',
        `this automation is triggered by tagging and also adds the tag "${(tagged as { tag: string }).tag}", which would trigger itself`));
    }
  }

  return ok(automation);
}

/** Human-readable summary, shown in the automation list. */
export function describeAutomation(automation: Automation): string {
  const trigger = automation.trigger.kind.replace(/_/g, ' ');
  const conditions = automation.conditions.length === 0
    ? ''
    : ` if ${automation.conditionMode === 'any' ? 'any of ' : ''}${automation.conditions.length} condition${automation.conditions.length === 1 ? '' : 's'} match`;
  const actions = automation.actions.map((a) => a.kind.replace(/_/g, ' ')).join(', ');
  return `When ${trigger}${conditions}, then ${actions}`;
}
