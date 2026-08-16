/**
 * Contact-detail extraction.
 *
 * Every function here returns candidates with a confidence weight rather than
 * a single answer. Phone numbers in a footer are worth more than ones buried
 * in prose; a `tel:` link is worth more than either. The pipeline turns these
 * weights into Fact confidence, and anything ambiguous lands in the review
 * queue instead of silently going live.
 */

export interface Candidate<T> {
  value: T;
  confidence: number;
  /** Where in the document it was found — shown in the review UI. */
  context: string;
}

const PHONE_RE =
  /(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?/gi;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const POSTAL_CA = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/i;
const ZIP_US = /\b\d{5}(?:-\d{4})?\b/;

/** Strings that look like phone numbers but are dates, prices or IDs. */
function looksLikeRealPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  if (/^(\d)\1+$/.test(digits)) return false;          // 0000000000
  if (/^(?:19|20)\d{2}/.test(digits) && digits.length === 10) {
    // Could be a date range like 2019-2024 concatenated; require separators
    // that a phone number would actually use.
    if (!/[()\s.-]/.test(raw)) return false;
  }
  return true;
}

export function normalizePhone(raw: string): string {
  const ext = /(?:x|ext\.?|extension)\s*(\d{1,6})/i.exec(raw);
  const digits = raw.replace(/(?:x|ext\.?|extension)\s*\d{1,6}/i, '').replace(/\D/g, '');
  const core = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const formatted =
    core.length === 10
      ? `${core.slice(0, 3)}-${core.slice(3, 6)}-${core.slice(6)}`
      : digits;
  return ext ? `${formatted} ext. ${ext[1]}` : formatted;
}

export function findPhones(text: string, context: string, baseConfidence = 0.6): Candidate<string>[] {
  const seen = new Map<string, Candidate<string>>();
  for (const match of text.matchAll(PHONE_RE)) {
    const raw = match[0];
    if (!looksLikeRealPhone(raw)) continue;
    const value = normalizePhone(raw);
    const existing = seen.get(value);
    if (existing) {
      existing.confidence = Math.min(0.95, existing.confidence + 0.05);
      continue;
    }
    seen.set(value, { value, confidence: baseConfidence, context });
  }
  return [...seen.values()];
}

export function findEmails(text: string, context: string, baseConfidence = 0.7): Candidate<string>[] {
  const seen = new Map<string, Candidate<string>>();
  for (const match of text.matchAll(EMAIL_RE)) {
    const value = match[0].toLowerCase();
    // Filter out asset filenames and tracking pixels that parse as emails.
    if (/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(value)) continue;
    if (/^(example|test|your|name|email)@/.test(value)) continue;
    if (!seen.has(value)) seen.set(value, { value, confidence: baseConfidence, context });
  }
  return [...seen.values()];
}

export interface AddressCandidate {
  raw: string;
  postalCode?: string;
  city?: string;
  region?: string;
}

/**
 * Address detection is intentionally conservative: we look for a line
 * containing a postal/zip code and take the surrounding text. Anything more
 * aggressive produces confident nonsense, which the spec forbids.
 */
export function findAddresses(text: string, context: string): Candidate<AddressCandidate>[] {
  const out: Candidate<AddressCandidate>[] = [];
  const lines = text.split(/\n|(?:\s{2,})|(?:\s*\|\s*)/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (line.length > 200) continue;
    const ca = POSTAL_CA.exec(line);
    const us = ZIP_US.exec(line);
    const postal = ca?.[0] ?? us?.[0];
    if (!postal) continue;
    if (!/\d+\s+\w/.test(line)) continue;               // needs a street number

    const value: AddressCandidate = { raw: line.replace(/\s+/g, ' ').trim(), postalCode: postal };
    const parts = value.raw.split(',').map((p) => p.trim());
    if (parts.length >= 3) {
      value.city = parts[parts.length - 2];
      value.region = parts[parts.length - 1]?.replace(postal, '').trim() || undefined;
    }
    out.push({ value, confidence: ca ? 0.8 : 0.75, context });
  }
  return out;
}

export type DayCode = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface HoursEntry {
  dayOfWeek: DayCode;
  opens?: string;
  closes?: string;
  closed: boolean;
}

const DAY_ALIASES: Array<[RegExp, DayCode]> = [
  [/\bmon(day)?\b/i, 'mon'],
  [/\btue(s|sday)?\b/i, 'tue'],
  [/\bwed(nesday)?\b/i, 'wed'],
  [/\bthu(r|rs|rsday)?\b/i, 'thu'],
  [/\bfri(day)?\b/i, 'fri'],
  [/\bsat(urday)?\b/i, 'sat'],
  [/\bsun(day)?\b/i, 'sun'],
];

const DAY_ORDER: DayCode[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function to24h(hour: number, minute: number, meridiem?: string): string {
  let h = hour;
  const m = meridiem?.toLowerCase();
  if (m === 'pm' && h < 12) h += 12;
  if (m === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const TIME_RANGE_RE =
  /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/**
 * Parse a line like "Mon – Fri: 9:00am – 5:00pm" or "Saturday: Closed".
 * Returns one entry per day covered by the line.
 */
export function parseHoursLine(line: string): HoursEntry[] {
  const daysMentioned: DayCode[] = [];
  for (const [re, code] of DAY_ALIASES) {
    if (re.test(line)) daysMentioned.push(code);
  }
  if (daysMentioned.length === 0) return [];

  // A day *range* ("Mon-Fri") expands; a list ("Mon, Wed") does not.
  let days = daysMentioned;
  const isRange = /(?:-|–|—|through|thru|to)/.test(line) && daysMentioned.length === 2;
  if (isRange) {
    const start = DAY_ORDER.indexOf(daysMentioned[0] as DayCode);
    const end = DAY_ORDER.indexOf(daysMentioned[1] as DayCode);
    if (start !== -1 && end !== -1 && start <= end) {
      days = DAY_ORDER.slice(start, end + 1);
    }
  }

  if (/\bclosed\b/i.test(line)) {
    return days.map((d) => ({ dayOfWeek: d, closed: true }));
  }

  const t = TIME_RANGE_RE.exec(line);
  if (!t) return [];

  // "9 - 5pm" — an unqualified opening hour inherits the closing meridiem
  // only when doing so keeps the range moving forward in time.
  const closeMeridiem = t[6];
  let openMeridiem = t[3];
  if (!openMeridiem && closeMeridiem) {
    const openHour = Number(t[1]);
    const closeHour = Number(t[4]);
    openMeridiem = openHour > closeHour ? 'am' : closeMeridiem;
  }

  const opens = to24h(Number(t[1]), Number(t[2] ?? 0), openMeridiem);
  const closes = to24h(Number(t[4]), Number(t[5] ?? 0), closeMeridiem);
  return days.map((d) => ({ dayOfWeek: d, opens, closes, closed: false }));
}

export function findOpeningHours(text: string, context: string): Candidate<HoursEntry[]>[] {
  const entries = new Map<DayCode, HoursEntry>();
  for (const line of text.split(/\n/)) {
    for (const entry of parseHoursLine(line)) {
      if (!entries.has(entry.dayOfWeek)) entries.set(entry.dayOfWeek, entry);
    }
  }
  if (entries.size === 0) return [];
  const value = DAY_ORDER.filter((d) => entries.has(d)).map((d) => entries.get(d) as HoursEntry);
  // Partial week coverage is a weaker signal than a full schedule.
  const confidence = value.length >= 5 ? 0.8 : 0.6;
  return [{ value, confidence, context }];
}

const SOCIAL_HOSTS: Record<string, string> = {
  'facebook.com': 'facebook',
  'fb.com': 'facebook',
  'instagram.com': 'instagram',
  'x.com': 'x',
  'twitter.com': 'x',
  'linkedin.com': 'linkedin',
  'youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'tiktok.com': 'tiktok',
  'pinterest.com': 'pinterest',
  'threads.net': 'threads',
  'yelp.com': 'yelp',
  'vimeo.com': 'vimeo',
};

export function classifySocialUrl(url: string): { network: string; handle?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const network = SOCIAL_HOSTS[host];
  if (!network) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  // Skip sharer/intent endpoints — those are share buttons, not profiles.
  if (segments[0] && ['sharer', 'share', 'intent', 'shareArticle'].includes(segments[0])) return null;
  const handle = segments[0]?.replace(/^@/, '');
  return handle ? { network, handle } : { network };
}
