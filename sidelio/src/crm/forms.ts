/**
 * Forms and submissions.
 *
 * A form definition is data, so the same definition renders the markup,
 * validates the submission on the server, and describes the columns of an
 * export. Validation written twice — once in the browser, once on the server —
 * always drifts, and the half that drifts is the one that matters.
 *
 * The security posture here is deliberate. A public form endpoint is the most
 * exposed surface a small business site has, so this module assumes every
 * submission is hostile until shown otherwise:
 *
 *  - Spam is scored, not guessed at. A honeypot, a time trap, and simple
 *    content heuristics each contribute; nothing is discarded silently,
 *    because a false positive is a lost customer nobody ever hears about.
 *  - Consent for marketing is recorded as an explicit act with a timestamp
 *    and the wording that was agreed to. A pre-ticked box is not consent under
 *    GDPR or CASL, and "we had their email" is not a defence.
 *  - Field values are stored as submitted and escaped at render, never
 *    sanitised on the way in — destroying the original makes a legitimate
 *    submission containing `<` unreadable and helps nobody.
 */

import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { SiteId } from '../core/ids.ts';

export type FieldType =
  | 'text' | 'textarea' | 'email' | 'phone' | 'number' | 'date'
  | 'select' | 'multiselect' | 'checkbox' | 'radio' | 'file' | 'hidden' | 'consent';

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** Anchored server-side; a client pattern is a hint, not a control. */
  pattern?: string;
  /** consent only: the exact wording agreed to, stored with the submission. */
  consentText?: string;
  /** Maps this answer onto a contact property. */
  mapsTo?: 'email' | 'name' | 'phone' | 'company' | 'message';
}

export interface Form {
  id: string;
  siteId: SiteId;
  name: string;
  fields: FormField[];
  /** Where the visitor lands afterwards; inline keeps them on the page. */
  successBehaviour: { kind: 'message'; message: string } | { kind: 'redirect'; url: string };
  notifyEmails: string[];
  /** Written onto every contact created from this form. */
  tags?: string[];
  spamProtection: {
    honeypotField: string;
    /** A human cannot complete a real form this fast. */
    minimumSecondsToComplete: number;
  };
  active: boolean;
  createdAt: string;
}

export interface Submission {
  id: string;
  siteId: SiteId;
  formId: string;
  values: Record<string, string | string[]>;
  /** Recorded for consent evidence and abuse investigation. */
  meta: {
    submittedAt: string;
    ip?: string;
    userAgent?: string;
    pageUrl?: string;
    referrer?: string;
  };
  spamScore: number;
  status: 'new' | 'read' | 'spam' | 'archived';
  contactId?: string;
  consent?: { granted: boolean; text: string; at: string };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface FieldError {
  key: string;
  message: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
// Deliberately loose: international numbering is not worth rejecting a real
// customer over, so this only catches obvious rubbish.
const PHONE = /^[+()\d][\d\s().-]{5,}$/;

export function validateSubmission(
  form: Form,
  raw: Record<string, unknown>,
): Result<{ values: Record<string, string | string[]>; consent?: Submission['consent'] }, FieldError[]> {
  const errors: FieldError[] = [];
  const values: Record<string, string | string[]> = {};
  let consent: Submission['consent'] | undefined;

  for (const field of form.fields) {
    const input = raw[field.key];
    const isList = field.type === 'multiselect';
    const provided = isList
      ? (Array.isArray(input) ? input.map(String) : input === undefined || input === '' ? [] : [String(input)])
      : String(input ?? '').trim();
    const empty = isList ? (provided as string[]).length === 0 : provided === '';

    if (field.type === 'consent') {
      const granted = input === true || input === 'true' || input === 'on' || input === '1';
      if (field.required && !granted) {
        errors.push({ key: field.key, message: `Please confirm: ${field.label}` });
      }
      // Consent is only evidence if the wording is stored with it. Recording
      // a bare boolean cannot answer "what did they agree to?" a year later.
      if (granted) {
        consent = { granted: true, text: field.consentText ?? field.label, at: new Date().toISOString() };
      }
      values[field.key] = granted ? 'true' : 'false';
      continue;
    }

    if (empty) {
      if (field.required) errors.push({ key: field.key, message: `${field.label} is required` });
      continue;
    }

    const value = provided as string;
    switch (field.type) {
      case 'email':
        if (!EMAIL.test(value)) errors.push({ key: field.key, message: `${field.label} does not look like an email address` });
        break;
      case 'phone':
        if (!PHONE.test(value)) errors.push({ key: field.key, message: `${field.label} does not look like a phone number` });
        break;
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) errors.push({ key: field.key, message: `${field.label} must be a number` });
        else if (field.min !== undefined && n < field.min) errors.push({ key: field.key, message: `${field.label} must be at least ${field.min}` });
        else if (field.max !== undefined && n > field.max) errors.push({ key: field.key, message: `${field.label} must be at most ${field.max}` });
        break;
      }
      case 'date':
        if (Number.isNaN(Date.parse(value))) errors.push({ key: field.key, message: `${field.label} is not a valid date` });
        break;
      case 'select':
      case 'radio':
        if (field.options && !field.options.some((o) => o.value === value)) {
          errors.push({ key: field.key, message: `${field.label} has an unexpected value` });
        }
        break;
      case 'multiselect': {
        const list = provided as string[];
        if (field.options) {
          const allowed = new Set(field.options.map((o) => o.value));
          if (list.some((v) => !allowed.has(v))) {
            errors.push({ key: field.key, message: `${field.label} has an unexpected value` });
          }
        }
        break;
      }
      default:
        if (field.min !== undefined && value.length < field.min) {
          errors.push({ key: field.key, message: `${field.label} must be at least ${field.min} characters` });
        }
        if (field.max !== undefined && value.length > field.max) {
          errors.push({ key: field.key, message: `${field.label} must be at most ${field.max} characters` });
        }
    }

    if (field.pattern) {
      // Anchored: an unanchored pattern matches anywhere in the string, which
      // is almost never what the author of a validation rule intended.
      const anchored = new RegExp(`^(?:${field.pattern})$`);
      if (!anchored.test(value)) {
        errors.push({ key: field.key, message: `${field.label} is not in the expected format` });
      }
    }

    values[field.key] = provided;
  }

  if (errors.length > 0) return fail(errors);
  return ok(consent ? { values, consent } : { values });
}

/* ------------------------------------------------------------------ */
/* Spam                                                                */
/* ------------------------------------------------------------------ */

export interface SpamSignals {
  /** Anything in the honeypot means a bot filled every field it found. */
  honeypotValue?: string;
  /** Seconds between the form rendering and submitting. */
  secondsToComplete?: number;
  values: Record<string, string | string[]>;
  /** Submissions from this address in the last hour. */
  recentFromSameIp?: number;
}

export interface SpamVerdict {
  score: number;
  /** 0.8 and above is treated as spam, but nothing is deleted. */
  isSpam: boolean;
  reasons: string[];
}

const SPAM_PHRASES = [
  'seo services', 'guest post', 'backlink', 'crypto', 'casino',
  'viagra', 'loan offer', 'work from home', 'increase your traffic',
];

/**
 * Score a submission for spam.
 *
 * Scored rather than blocked outright, and never deleted. A false positive on
 * a contact form is a customer who believes they were ignored — the worst
 * possible failure for the businesses this serves — so suspicious submissions
 * are flagged for a human, not discarded.
 */
export function scoreSpam(form: Form, signals: SpamSignals): SpamVerdict {
  const reasons: string[] = [];
  let score = 0;

  if (signals.honeypotValue && signals.honeypotValue.trim() !== '') {
    score += 0.9;
    reasons.push('a hidden field that humans cannot see was filled in');
  }

  const seconds = signals.secondsToComplete;
  if (seconds !== undefined && seconds >= 0 && seconds < form.spamProtection.minimumSecondsToComplete) {
    score += 0.5;
    reasons.push(`submitted in ${seconds}s, faster than a person can type`);
  }

  const text = Object.values(signals.values)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .join(' ')
    .toLowerCase();

  const phrase = SPAM_PHRASES.find((p) => text.includes(p));
  if (phrase) {
    score += 0.35;
    reasons.push(`contains the phrase "${phrase}"`);
  }

  const links = (text.match(/https?:\/\//g) ?? []).length;
  if (links >= 3) {
    score += 0.4;
    reasons.push(`contains ${links} links`);
  }

  if ((signals.recentFromSameIp ?? 0) > 5) {
    score += 0.3;
    reasons.push('many submissions from the same address in a short window');
  }

  // A message that is nothing but a URL is almost never a real enquiry.
  if (/^\s*https?:\/\/\S+\s*$/.test(text)) {
    score += 0.3;
    reasons.push('the message is only a link');
  }

  score = Math.min(1, Number(score.toFixed(2)));
  return { score, isSpam: score >= 0.8, reasons };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/**
 * CSV export of submissions.
 *
 * Values beginning with a formula character are prefixed with an apostrophe.
 * A submission of `=cmd|'/c calc'!A1` in a name field becomes a live formula
 * when the export is opened in Excel — CSV injection is a real attack on the
 * person who downloads the file, not on the site.
 */
export function submissionsToCsv(form: Form, submissions: Submission[]): string {
  const columns = form.fields.filter((f) => f.type !== 'hidden');
  const header = ['Submitted at', 'Status', 'Spam score', ...columns.map((f) => f.label)];

  const rows = submissions.map((s) => [
    s.meta.submittedAt,
    s.status,
    String(s.spamScore),
    ...columns.map((f) => {
      const value = s.values[f.key];
      return Array.isArray(value) ? value.join('; ') : (value ?? '');
    }),
  ]);

  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function csvCell(value: string): string {
  let out = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(out)) out = `'${out}`;
  if (/["\n\r,]/.test(out)) out = `"${out.replace(/"/g, '""')}"`;
  return out;
}

/** Contact fields implied by a submission, via each field's `mapsTo`. */
export function contactFieldsFrom(form: Form, values: Record<string, string | string[]>): {
  email?: string; name?: string; phone?: string; company?: string; message?: string;
} {
  const out: Record<string, string> = {};
  for (const field of form.fields) {
    if (!field.mapsTo) continue;
    const value = values[field.key];
    const text = Array.isArray(value) ? value.join(', ') : value;
    if (text) out[field.mapsTo] = text;
  }
  return out;
}

export function validateFormDefinition(form: Form): Result<Form> {
  if (form.fields.length === 0) {
    return fail(err('VALIDATION_FAILED', 'a form needs at least one field'));
  }
  const keys = new Set<string>();
  for (const field of form.fields) {
    if (!/^[a-z][a-z0-9_]*$/i.test(field.key)) {
      return fail(err('VALIDATION_FAILED', `"${field.key}" is not a usable field key`));
    }
    if (keys.has(field.key)) {
      return fail(err('CONFLICT', `two fields share the key "${field.key}"`));
    }
    keys.add(field.key);
    if ((field.type === 'select' || field.type === 'radio' || field.type === 'multiselect')
      && (field.options?.length ?? 0) === 0) {
      return fail(err('VALIDATION_FAILED', `"${field.label}" is a choice field with no options`));
    }
    if (field.pattern) {
      try { new RegExp(field.pattern); }
      catch { return fail(err('VALIDATION_FAILED', `"${field.label}" has an invalid pattern`)); }
    }
  }
  if (form.fields.some((f) => f.key === form.spamProtection.honeypotField)) {
    // A honeypot that is also a real field traps every genuine submission.
    return fail(err('VALIDATION_FAILED', 'the honeypot field name collides with a real field'));
  }
  return ok(form);
}
