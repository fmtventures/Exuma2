import { describe, expect, it } from 'vitest';
import { asId, type SiteId } from '../src/core/ids.ts';
import {
  contactFieldsFrom, csvCell, scoreSpam, submissionsToCsv,
  validateFormDefinition, validateSubmission,
  type Form, type Submission,
} from '../src/crm/forms.ts';
import {
  contactsToCsv, eraseContact, findContact, hasConsent, identityKey, moveDeal,
  phoneKey, stalledDeals, summarisePipeline, timelineFor, upsertContact,
  withdrawConsent, type Activity, type Contact, type ConsentRecord, type Deal, type PipelineStage,
} from '../src/crm/contacts.ts';
import {
  conditionsPass, describeAutomation, dispatch, evaluateCondition, executeAutomation,
  readPath, validateAutomation, MAX_CHAIN_DEPTH,
  type Action, type ActionHandler, type Automation, type AutomationRun,
} from '../src/automation/engine.ts';

const SITE = asId<SiteId>('site_c');
const NOW = new Date('2026-06-01T12:00:00Z');
let seq = 0;
const makeId = (p: string) => `${p}_${String(++seq).padStart(4, '0')}`;

/* ------------------------------------------------------------------ */

const form: Form = {
  id: 'frm_1', siteId: SITE, name: 'Contact',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, mapsTo: 'name' },
    { key: 'email', label: 'Email', type: 'email', required: true, mapsTo: 'email' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'service', label: 'Service', type: 'select', options: [{ value: 'roof', label: 'Roofing' }] },
    { key: 'message', label: 'Message', type: 'textarea', max: 2000, mapsTo: 'message' },
  ],
  successBehaviour: { kind: 'message', message: 'Thanks' },
  notifyEmails: ['owner@example.com'],
  spamProtection: { honeypotField: 'website_url', minimumSecondsToComplete: 3 },
  active: true,
  createdAt: NOW.toISOString(),
};

describe('form validation', () => {
  it('accepts a good submission', () => {
    const r = validateSubmission(form, { name: 'Sam', email: 'sam@example.com', message: 'Hello' });
    expect(r.ok).toBe(true);
  });

  it('reports every problem at once rather than one at a time', () => {
    const r = validateSubmission(form, { email: 'nope' });
    expect(r.ok).toBe(false);
    const errors = (r as { error: { key: string }[] }).error;
    expect(errors.map((e) => e.key).sort()).toEqual(['email', 'name']);
  });

  it('rejects a choice value that was not offered', () => {
    const r = validateSubmission(form, { name: 'A', email: 'a@b.co', service: 'gold-plating' });
    expect(r.ok).toBe(false);
  });

  it('anchors patterns so they cannot match a substring', () => {
    // An unanchored rule accepts "postcode: X0X0X0 and also <script>".
    const patterned: Form = {
      ...form,
      fields: [{ key: 'code', label: 'Code', type: 'text', required: true, pattern: '[A-Z]\\d[A-Z]' }],
    };
    expect(validateSubmission(patterned, { code: 'A1B' }).ok).toBe(true);
    expect(validateSubmission(patterned, { code: 'xxA1Bxx' }).ok).toBe(false);
  });

  it('records the consent wording, not just a boolean', () => {
    // "Did they agree?" is answerable a year later only if the text is stored.
    const withConsent: Form = {
      ...form,
      fields: [...form.fields, {
        key: 'optin', label: 'Marketing', type: 'consent', required: false,
        consentText: 'Email me occasional offers',
      }],
    };
    const r = validateSubmission(withConsent, { name: 'A', email: 'a@b.co', optin: true });
    expect((r as { value: { consent?: { text: string } } }).value.consent?.text).toBe('Email me occasional offers');
  });

  it('treats an unticked required consent box as a failure', () => {
    const withConsent: Form = {
      ...form,
      fields: [{ key: 'terms', label: 'Accept terms', type: 'consent', required: true }],
    };
    expect(validateSubmission(withConsent, {}).ok).toBe(false);
    expect(validateSubmission(withConsent, { terms: 'on' }).ok).toBe(true);
  });

  it('rejects a form whose honeypot collides with a real field', () => {
    // A honeypot that is also a real field traps every genuine submission.
    const broken: Form = { ...form, spamProtection: { ...form.spamProtection, honeypotField: 'email' } };
    expect(validateFormDefinition(broken).ok).toBe(false);
  });

  it('rejects duplicate field keys and empty choice lists', () => {
    expect(validateFormDefinition({ ...form, fields: [form.fields[0]!, form.fields[0]!] }).ok).toBe(false);
    expect(validateFormDefinition({
      ...form, fields: [{ key: 'x', label: 'X', type: 'select', options: [] }],
    }).ok).toBe(false);
  });

  it('maps answers onto contact fields', () => {
    const fields = contactFieldsFrom(form, { name: 'Sam', email: 'sam@example.com', message: 'Hi' });
    expect(fields).toEqual({ name: 'Sam', email: 'sam@example.com', message: 'Hi' });
  });
});

describe('spam scoring', () => {
  const signals = (over: Record<string, unknown> = {}) =>
    ({ values: { message: 'Can you quote for a new roof?' }, secondsToComplete: 40, ...over });

  it('leaves a real enquiry alone', () => {
    expect(scoreSpam(form, signals()).isSpam).toBe(false);
  });

  it('catches a filled honeypot', () => {
    const verdict = scoreSpam(form, signals({ honeypotValue: 'http://spam' }));
    expect(verdict.isSpam).toBe(true);
    expect(verdict.reasons[0]).toMatch(/hidden field/);
  });

  it('catches a submission faster than a person can type', () => {
    expect(scoreSpam(form, signals({ secondsToComplete: 1 })).score).toBeGreaterThan(0);
  });

  it('flags rather than deletes, so a false positive is recoverable', () => {
    // A wrongly binned enquiry is a customer who thinks they were ignored.
    const verdict = scoreSpam(form, signals({ values: { message: 'cheap backlink seo services' } }));
    expect(verdict.score).toBeGreaterThan(0);
    expect(verdict.reasons.length).toBeGreaterThan(0);
    expect(verdict.score).toBeLessThanOrEqual(1);
  });

  it('never exceeds a score of one however many signals fire', () => {
    const verdict = scoreSpam(form, signals({
      honeypotValue: 'x', secondsToComplete: 0, recentFromSameIp: 50,
      values: { message: 'crypto casino http://a http://b http://c backlink' },
    }));
    expect(verdict.score).toBe(1);
  });
});

describe('csv export is safe to open', () => {
  it('neutralises formula injection', () => {
    // "=cmd|'/c calc'!A1" in a name field executes when opened in Excel.
    expect(csvCell('=cmd|calc')).toBe("'=cmd|calc");
    expect(csvCell('+1-902-555-1234')).toBe("'+1-902-555-1234");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('quotes cells containing separators', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('exports submissions with a header row', () => {
    const submission: Submission = {
      id: 's1', siteId: SITE, formId: 'frm_1',
      values: { name: '=danger', email: 'a@b.co' },
      meta: { submittedAt: NOW.toISOString() }, spamScore: 0, status: 'new',
    };
    const csv = submissionsToCsv(form, [submission]);
    expect(csv.split('\r\n')[0]).toContain('Name');
    expect(csv).toContain("'=danger");
  });
});

/* ------------------------------------------------------------------ */

const contact = (over: Partial<Contact> = {}): Contact => ({
  id: 'con_1', siteId: SITE, email: 'sam@example.com', tags: [], properties: {},
  consent: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
});

describe('contact identity', () => {
  it('matches case and whitespace but not plus-tags or dots', () => {
    // a.b@gmail.com and ab@gmail.com are one Gmail inbox but different
    // addresses elsewhere; merging them combines two real customers.
    expect(identityKey(' Sam@Example.COM ')).toBe('sam@example.com');
    expect(identityKey('a.b@gmail.com')).not.toBe(identityKey('ab@gmail.com'));
    expect(identityKey('a+tag@x.co')).not.toBe(identityKey('a@x.co'));
  });

  it('matches phone numbers written differently', () => {
    expect(phoneKey('(902) 555-1234')).toBe(phoneKey('902-555-1234'));
    expect(phoneKey('+1 902 555 1234')).toBe(phoneKey('9025551234'));
  });

  it('finds by email first, then phone', () => {
    const list = [contact({ id: 'a' }), contact({ id: 'b', email: undefined, phone: '902-555-9999' })];
    expect(findContact(list, { email: 'SAM@example.com' })?.id).toBe('a');
    expect(findContact(list, { phone: '(902) 555 9999' })?.id).toBe('b');
    expect(findContact(list, { email: 'nobody@x.co' })).toBeUndefined();
  });
});

describe('contact upsert', () => {
  it('never overwrites a known value with nothing', () => {
    // A booking form collecting no company must not wipe the company on file.
    const existing = contact({ company: 'Acme Roofing', name: 'Sam' });
    const r = upsertContact(existing, { siteId: SITE, email: 'sam@example.com', now: NOW, makeId });
    expect((r as { value: Contact }).value.company).toBe('Acme Roofing');
    expect((r as { value: Contact }).value.name).toBe('Sam');
  });

  it('unions tags rather than replacing them', () => {
    const existing = contact({ tags: ['lead'] });
    const r = upsertContact(existing, { siteId: SITE, email: 'sam@example.com', tags: ['roofing'], now: NOW, makeId });
    expect((r as { value: Contact }).value.tags.sort()).toEqual(['lead', 'roofing']);
  });

  it('requires some way to reach the person', () => {
    expect(upsertContact(undefined, { siteId: SITE, name: 'Anon', now: NOW, makeId }).ok).toBe(false);
  });

  it('refuses to resurrect an erased contact', () => {
    const erased = eraseContact(contact(), NOW);
    expect(upsertContact(erased, { siteId: SITE, email: 'sam@example.com', now: NOW, makeId }).ok).toBe(false);
  });
});

describe('consent is a legal record', () => {
  const grant = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
    channel: 'email_marketing', basis: 'express', granted: true,
    text: 'Email me offers', source: 'contact form', at: '2026-05-01T00:00:00Z', ...over,
  });

  it('defaults to no consent when nothing is recorded', () => {
    // The absence of a refusal is not permission.
    expect(hasConsent(contact(), 'email_marketing', NOW)).toBe(false);
  });

  it('honours an express grant', () => {
    expect(hasConsent(contact({ consent: [grant()] }), 'email_marketing', NOW)).toBe(true);
  });

  it('expires implied consent', () => {
    const implied = grant({ basis: 'implied', expiresAt: '2026-05-15T00:00:00Z' });
    expect(hasConsent(contact({ consent: [implied] }), 'email_marketing', NOW)).toBe(false);
  });

  it('withdraws by appending, keeping the evidence of the earlier grant', () => {
    // Erasing the grant makes the sends that preceded it indefensible.
    const granted = contact({ consent: [grant()] });
    const withdrawn = withdrawConsent(granted, 'email_marketing', 'unsubscribe link', NOW);
    expect(hasConsent(withdrawn, 'email_marketing', NOW)).toBe(false);
    expect(withdrawn.consent).toHaveLength(2);
    expect(withdrawn.consent[0]!.granted).toBe(true);
  });

  it('keeps channels independent', () => {
    const c = contact({ consent: [grant(), grant({ channel: 'sms_marketing', granted: false, basis: 'withdrawn' })] });
    expect(hasConsent(c, 'email_marketing', NOW)).toBe(true);
    expect(hasConsent(c, 'sms_marketing', NOW)).toBe(false);
  });

  it('erasure clears identifiers but keeps the consent history', () => {
    const erased = eraseContact(contact({ name: 'Sam', consent: [grant()] }), NOW);
    expect(erased.email).toBeUndefined();
    expect(erased.name).toBeUndefined();
    expect(erased.consent).toHaveLength(1);
    expect(hasConsent(erased, 'email_marketing', NOW)).toBe(false);
  });

  it('excludes erased contacts from a marketing export', () => {
    const csv = contactsToCsv([contact({ consent: [grant()] }), eraseContact(contact({ id: 'c2' }), NOW)], NOW);
    expect(csv.split('\r\n')).toHaveLength(3);
    expect(csv).toContain('yes');
  });
});

describe('pipeline', () => {
  const stages: PipelineStage[] = [
    { id: 'new', name: 'New', position: 0 },
    { id: 'quoted', name: 'Quoted', position: 1 },
    { id: 'won', name: 'Won', position: 2, outcome: 'won' },
    { id: 'lost', name: 'Lost', position: 3, outcome: 'lost' },
  ];
  const deal = (over: Partial<Deal> = {}): Deal => ({
    id: 'dl_1', siteId: SITE, contactId: 'con_1', title: 'Re-roof', stageId: 'new',
    valueMinor: 500000, currency: 'CAD', createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z', ...over,
  });

  it('requires a reason when marking a deal lost', () => {
    // A lost deal with no reason teaches the business nothing.
    expect(moveDeal(deal(), stages[3]!, NOW).ok).toBe(false);
    expect(moveDeal(deal(), stages[3]!, NOW, 'price').ok).toBe(true);
  });

  it('closes the deal when it reaches an outcome stage', () => {
    const won = moveDeal(deal(), stages[2]!, NOW);
    expect((won as { value: Deal }).value.outcome).toBe('won');
    expect((won as { value: Deal }).value.closedAt).toBe(NOW.toISOString());
  });

  it('refuses to move a closed deal back into the pipeline', () => {
    const won = (moveDeal(deal(), stages[2]!, NOW) as { value: Deal }).value;
    expect(moveDeal(won, stages[0]!, NOW).ok).toBe(false);
  });

  it('summarises open value per stage, ignoring closed deals', () => {
    const summary = summarisePipeline(stages, [deal(), deal({ id: 'd2', closedAt: NOW.toISOString() })]);
    expect(summary[0]).toMatchObject({ stageId: 'new', count: 1, valueMinor: 500000 });
  });

  it('finds deals going cold', () => {
    const activities: Activity[] = [{
      id: 'a1', siteId: SITE, contactId: 'con_1', kind: 'note_added',
      summary: 'Called', at: '2026-01-02T00:00:00Z',
    }];
    expect(stalledDeals([deal()], activities, 30, NOW)).toHaveLength(1);
    expect(stalledDeals([deal()], [{ ...activities[0]!, at: NOW.toISOString() }], 30, NOW)).toHaveLength(0);
  });

  it('orders a timeline newest first', () => {
    const activities: Activity[] = [
      { id: 'a1', siteId: SITE, contactId: 'con_1', kind: 'note_added', summary: 'old', at: '2026-01-01T00:00:00Z' },
      { id: 'a2', siteId: SITE, contactId: 'con_1', kind: 'note_added', summary: 'new', at: '2026-05-01T00:00:00Z' },
    ];
    expect(timelineFor(activities, 'con_1')[0]!.summary).toBe('new');
  });
});

/* ------------------------------------------------------------------ */

const automation = (over: Partial<Automation> = {}): Automation => ({
  id: 'aut_1', siteId: SITE, name: 'Tag roofing leads',
  trigger: { kind: 'form_submitted' },
  conditions: [], conditionMode: 'all',
  actions: [{ kind: 'add_tag', tag: 'lead' }],
  enabled: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over,
});

const okHandler: ActionHandler = (action) => ({ action, status: 'ok' });

describe('conditions', () => {
  const payload = { order: { total: 15000, currency: 'CAD' }, contact: { tags: ['vip', 'lead'], name: 'Sam' } };

  it('reads dotted paths', () => {
    expect(readPath(payload, 'order.total')).toBe(15000);
    expect(readPath(payload, 'contact.tags.0')).toBe('vip');
    expect(readPath(payload, 'nope.deep.path')).toBeUndefined();
  });

  it('compares a string form value against a configured number', () => {
    // Strict equality would make every numeric condition silently false.
    expect(evaluateCondition({ path: 'order.total', operator: 'equals', value: '15000' }, payload)).toBe(true);
    expect(evaluateCondition({ path: 'order.total', operator: 'greater_than', value: 10000 }, payload)).toBe(true);
  });

  it('handles list membership both ways round', () => {
    expect(evaluateCondition({ path: 'contact.tags', operator: 'contains', value: 'vip' }, payload)).toBe(true);
    expect(evaluateCondition({ path: 'order.currency', operator: 'in', value: ['CAD', 'USD'] }, payload)).toBe(true);
  });

  it('fails a comparison against an unparseable value rather than throwing', () => {
    expect(evaluateCondition({ path: 'contact.name', operator: 'greater_than', value: 5 }, payload)).toBe(false);
  });

  it('honours all versus any', () => {
    const conditions = [
      { path: 'order.total', operator: 'greater_than' as const, value: 999999 },
      { path: 'order.currency', operator: 'equals' as const, value: 'CAD' },
    ];
    expect(conditionsPass(automation({ conditions, conditionMode: 'all' }), payload)).toBe(false);
    expect(conditionsPass(automation({ conditions, conditionMode: 'any' }), payload)).toBe(true);
  });
});

describe('automation execution', () => {
  const run = (over: Record<string, unknown> = {}) => executeAutomation({
    automation: automation(), triggerKind: 'form_submitted', payload: {},
    idempotencyKey: 'k1', handler: okHandler, now: NOW, makeId, ...over,
  });

  it('runs the actions and records each outcome', async () => {
    const result = await run();
    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(1);
  });

  it('explains every skip rather than staying silent', async () => {
    // "Why didn't my automation fire?" needs an answer.
    const off = await run({ automation: automation({ enabled: false }) });
    expect(off.status).toBe('skipped');
    expect(off.reason).toMatch(/turned off/);

    const unmatched = await run({
      automation: automation({ conditions: [{ path: 'x', operator: 'is_set' }] }),
    });
    expect(unmatched.reason).toMatch(/conditions did not match/);
  });

  it('stops a loop when an automation is already in the chain', async () => {
    const result = await run({ causedBy: ['aut_1'] });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/stopped a loop/);
  });

  it('caps how deep a chain can go', async () => {
    const deep = Array.from({ length: MAX_CHAIN_DEPTH }, (_, i) => `other_${i}`);
    const result = await run({ causedBy: deep });
    expect(result.reason).toMatch(/deep/);
  });

  it('rate limits so a bulk import cannot fire ten thousand emails', async () => {
    const limited = automation({ maxRunsPerHour: 10 });
    const result = await run({ automation: limited, recentRunCount: 10 });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/rate limit/);
  });

  it('honours a per-contact re-entry window', async () => {
    const windowed = automation({ reentryWindowMinutes: 60 });
    const recent = new Date(NOW.getTime() - 10 * 60000).toISOString();
    const result = await run({ automation: windowed, contactId: 'con_1', lastRunForContactAt: recent });
    expect(result.status).toBe('skipped');
  });

  it('stops on the first failed action instead of running later steps', async () => {
    // Sending step three after step one failed is worse than sending nothing.
    const failing: ActionHandler = (action) =>
      action.kind === 'add_tag' ? { action, status: 'failed', detail: 'tag service down' } : { action, status: 'ok' };
    const result = await run({
      automation: automation({ actions: [{ kind: 'add_tag', tag: 'x' }, { kind: 'send_email', to: 'contact', templateId: 't' }] }),
      handler: failing,
    });
    expect(result.status).toBe('failed');
    expect(result.steps).toHaveLength(1);
  });

  it('treats a handler that throws as a failure, not a crash', async () => {
    const thrower: ActionHandler = () => { throw new Error('smtp refused'); };
    const result = await run({ handler: thrower });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('smtp refused');
  });

  it('treats a handler returning nothing as a failure, not a success', async () => {
    // Assuming success is exactly how silent failure gets in.
    const silent = (() => undefined) as unknown as ActionHandler;
    const result = await run({ handler: silent });
    expect(result.status).toBe('failed');
  });

  it('suspends on a wait so drip sequences work', async () => {
    const result = await run({
      automation: automation({ actions: [{ kind: 'wait', minutes: 60 }, { kind: 'add_tag', tag: 'later' }] }),
    });
    expect(result.status).toBe('waiting');
    expect(result.steps).toHaveLength(1);
  });
});

describe('dispatch', () => {
  it('is idempotent, so a redelivered trigger does not repeat its effects', async () => {
    const first = await dispatch({
      automations: [automation()], triggerKind: 'form_submitted', payload: {},
      idempotencyKey: 'evt_1', existingRuns: [], handler: okHandler, now: NOW, makeId,
    });
    const second = await dispatch({
      automations: [automation()], triggerKind: 'form_submitted', payload: {},
      idempotencyKey: 'evt_1', existingRuns: first, handler: okHandler, now: NOW, makeId,
    });
    expect(second).toEqual(first);
  });

  it('only runs automations bound to the form that fired', async () => {
    const bound = automation({ id: 'aut_2', trigger: { kind: 'form_submitted', formId: 'frm_9' } });
    const runs = await dispatch({
      automations: [bound], triggerKind: 'form_submitted', payload: { formId: 'frm_1' },
      idempotencyKey: 'k', existingRuns: [], handler: okHandler, now: NOW, makeId,
    });
    expect(runs).toHaveLength(0);
  });

  it('applies the rate limit from real recent runs', async () => {
    const limited = automation({ maxRunsPerHour: 1 });
    const existing: AutomationRun[] = [{
      id: 'run_0', siteId: SITE, automationId: 'aut_1', triggerKind: 'form_submitted',
      idempotencyKey: 'older', status: 'completed', steps: [], causedBy: [],
      startedAt: new Date(NOW.getTime() - 60000).toISOString(),
    }];
    const runs = await dispatch({
      automations: [limited], triggerKind: 'form_submitted', payload: {},
      idempotencyKey: 'new', existingRuns: existing, handler: okHandler, now: NOW, makeId,
    });
    expect(runs[0]!.status).toBe('skipped');
  });
});

describe('automation validation', () => {
  it('refuses a webhook that is not https', () => {
    const action: Action = { kind: 'notify_webhook', url: 'http://example.com/hook' };
    expect(validateAutomation(automation({ actions: [action] })).ok).toBe(false);
  });

  it('refuses a webhook pointed at the internal network', () => {
    // Otherwise an automation is a request-forgery primitive.
    for (const url of [
      'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x',
      'https://169.254.169.254/latest/meta-data', 'https://192.168.1.1/x',
      'https://172.16.0.1/x', 'https://db.internal/x',
    ]) {
      const r = validateAutomation(automation({ actions: [{ kind: 'notify_webhook', url }] }));
      expect(r.ok, url).toBe(false);
    }
  });

  it('allows an ordinary https webhook', () => {
    expect(validateAutomation(automation({
      actions: [{ kind: 'notify_webhook', url: 'https://hooks.example.com/abc' }],
    })).ok).toBe(true);
  });

  it('catches the self-triggering tag loop at save time', () => {
    const r = validateAutomation(automation({
      trigger: { kind: 'contact_tagged' }, actions: [{ kind: 'add_tag', tag: 'vip' }],
    }));
    expect(r.ok).toBe(false);
    expect(String((r as { error: Error }).error.message)).toMatch(/trigger itself/);
  });

  it('requires a schedule for a scheduled automation', () => {
    expect(validateAutomation(automation({ trigger: { kind: 'schedule' } })).ok).toBe(false);
  });

  it('rejects an unreadable condition path', () => {
    expect(validateAutomation(automation({
      conditions: [{ path: 'order..total; drop', operator: 'is_set' }],
    })).ok).toBe(false);
  });

  it('describes itself in plain language', () => {
    expect(describeAutomation(automation())).toBe('When form submitted, then add tag');
  });
});
