/**
 * Analytics, billing metering and agency roll-up.
 *
 * These three share a spine: they all aggregate events into counters that
 * someone makes a decision from. Keeping them together keeps the aggregation
 * honest — a "visit" in the analytics dashboard and a "visit" on the invoice
 * must be the same number, or the merchant is right to distrust both.
 *
 * Analytics here is deliberately cookieless and first-party. Not as a feature
 * claim, but because the alternative obliges every customer of every merchant
 * to a consent banner, and a small business site does not need to hand a third
 * party its visitors in order to count them.
 */

import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { OrgId, SiteId } from '../core/ids.ts';

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export type MetricEventKind =
  | 'page_view' | 'form_submitted' | 'booking_created' | 'order_placed'
  | 'product_viewed' | 'cart_started' | 'checkout_started' | 'search'
  | 'outbound_click' | 'file_download' | 'call_click' | 'email_click';

export interface MetricEvent {
  siteId: SiteId;
  kind: MetricEventKind;
  at: string;
  path?: string;
  referrer?: string;
  /**
   * A daily-rotating hash of IP + user agent + site salt. Enough to count
   * unique visitors within a day, and useless for tracking anyone across days
   * or across sites — which is the property that makes it cookieless without
   * quietly being a fingerprint.
   */
  visitorHash?: string;
  /** Rolled up rather than stored raw, so the table stays small. */
  device?: 'mobile' | 'tablet' | 'desktop';
  country?: string;
  /** Revenue in minor units, on commerce events only. */
  valueMinor?: number;
  currency?: string;
  durationMs?: number;
}

export interface Totals {
  views: number;
  visitors: number;
  forms: number;
  bookings: number;
  orders: number;
  revenueMinor: number;
}

const EMPTY: Totals = { views: 0, visitors: 0, forms: 0, bookings: 0, orders: 0, revenueMinor: 0 };

export function summarise(events: MetricEvent[]): Totals {
  const visitors = new Set<string>();
  const totals = { ...EMPTY };
  for (const event of events) {
    if (event.visitorHash) visitors.add(event.visitorHash);
    switch (event.kind) {
      case 'page_view': totals.views++; break;
      case 'form_submitted': totals.forms++; break;
      case 'booking_created': totals.bookings++; break;
      case 'order_placed':
        totals.orders++;
        totals.revenueMinor += event.valueMinor ?? 0;
        break;
      default: break;
    }
  }
  totals.visitors = visitors.size;
  return totals;
}

/**
 * Bucket events by local day.
 *
 * Grouped in the site's own timezone, because a merchant comparing Monday to
 * Tuesday means their Monday. UTC bucketing silently moves every evening
 * booking in the Americas into the following day.
 */
export function byDay(events: MetricEvent[], timezone: string): Map<string, Totals> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const buckets = new Map<string, MetricEvent[]>();
  for (const event of events) {
    const day = formatter.format(new Date(event.at));
    buckets.set(day, [...(buckets.get(day) ?? []), event]);
  }
  return new Map([...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => [day, summarise(list)]));
}

export interface PageStat {
  path: string;
  views: number;
  visitors: number;
  /** Sessions that saw only this page. */
  bounceRate: number;
}

export function topPages(events: MetricEvent[], limit = 20): PageStat[] {
  const byPath = new Map<string, { views: number; visitors: Set<string> }>();
  const pagesPerVisitor = new Map<string, Set<string>>();

  for (const event of events) {
    if (event.kind !== 'page_view' || !event.path) continue;
    const entry = byPath.get(event.path) ?? { views: 0, visitors: new Set<string>() };
    entry.views++;
    if (event.visitorHash) {
      entry.visitors.add(event.visitorHash);
      const seen = pagesPerVisitor.get(event.visitorHash) ?? new Set<string>();
      seen.add(event.path);
      pagesPerVisitor.set(event.visitorHash, seen);
    }
    byPath.set(event.path, entry);
  }

  return [...byPath.entries()]
    .map(([path, entry]) => {
      const single = [...entry.visitors].filter((v) => (pagesPerVisitor.get(v)?.size ?? 0) === 1).length;
      return {
        path,
        views: entry.views,
        visitors: entry.visitors.size,
        bounceRate: entry.visitors.size === 0 ? 0 : Number((single / entry.visitors.size).toFixed(3)),
      };
    })
    .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/**
 * Group referrers into named sources.
 *
 * Self-referrals are dropped rather than shown. A site's own hostname
 * appearing as its top traffic source is a measurement artifact, and it
 * crowds out the sources the merchant can actually act on.
 */
export function topSources(events: MetricEvent[], ownHostname: string, limit = 10): { source: string; visits: number }[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 'page_view') continue;
    const source = classifyReferrer(event.referrer, ownHostname);
    if (source === null) continue;
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, visits]) => ({ source, visits }))
    .sort((a, b) => b.visits - a.visits || a.source.localeCompare(b.source))
    .slice(0, limit);
}

const SEARCH = /(google|bing|duckduckgo|yahoo|ecosia|brave|baidu|yandex)\./i;
const SOCIAL = /(facebook|instagram|twitter|x\.com|linkedin|tiktok|pinterest|reddit|youtube)\./i;

export function classifyReferrer(referrer: string | undefined, ownHostname: string): string | null {
  if (!referrer || referrer.trim() === '') return 'Direct';
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'Direct';
  }
  const own = ownHostname.toLowerCase().replace(/^www\./, '');
  if (host === own) return null;
  if (SEARCH.test(host)) return `Search — ${host.split('.')[0]}`;
  if (SOCIAL.test(host)) return `Social — ${host.split('.')[0]}`;
  return host;
}

/* ------------------------------------------------------------------ */
/* Billing and metering                                                */
/* ------------------------------------------------------------------ */

export interface PlanLimits {
  sites: number;
  pagesPerSite: number;
  monthlyPageViews: number;
  storageMb: number;
  products: number;
  staffSeats: number;
  aiCreditsPerMonth: number;
  customDomains: number;
}

export interface Plan {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  interval: 'month' | 'year';
  limits: PlanLimits;
  features: string[];
}

export interface Usage {
  sites: number;
  pages: number;
  monthlyPageViews: number;
  storageMb: number;
  products: number;
  staffSeats: number;
  aiCreditsUsed: number;
  customDomains: number;
}

export type LimitVerdict = {
  key: keyof PlanLimits;
  used: number;
  limit: number;
  /** 0–1. Over 1 means exceeded. */
  ratio: number;
  state: 'ok' | 'approaching' | 'exceeded';
};

/**
 * Compare usage against a plan.
 *
 * Reported per limit rather than as one boolean so the UI can warn at 80%
 * instead of blocking at 100% — a merchant who discovers a limit by being
 * cut off mid-launch does not renew.
 */
export function checkLimits(plan: Plan, usage: Usage): LimitVerdict[] {
  const pairs: [keyof PlanLimits, number][] = [
    ['sites', usage.sites],
    ['pagesPerSite', usage.pages],
    ['monthlyPageViews', usage.monthlyPageViews],
    ['storageMb', usage.storageMb],
    ['products', usage.products],
    ['staffSeats', usage.staffSeats],
    ['aiCreditsPerMonth', usage.aiCreditsUsed],
    ['customDomains', usage.customDomains],
  ];
  return pairs.map(([key, used]) => {
    const limit = plan.limits[key];
    // Unlimited is expressed as Infinity, not as zero or a magic -1, so the
    // ratio maths stays sane and a zero limit genuinely means zero.
    const ratio = limit === Infinity ? 0 : limit === 0 ? (used > 0 ? Infinity : 0) : used / limit;
    return {
      key, used, limit, ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(3)) : ratio,
      state: ratio > 1 ? 'exceeded' : ratio >= 0.8 ? 'approaching' : 'ok',
    };
  });
}

/**
 * Decide whether an action that consumes a limit may proceed.
 *
 * Content the merchant already has is never taken away for being over a limit
 * — an overage blocks *adding*, never *serving*. Deleting or hiding a paying
 * customer's live pages because their traffic grew is a way to lose them.
 */
export function canConsume(plan: Plan, usage: Usage, key: keyof PlanLimits, amount = 1): Result<true> {
  const limit = plan.limits[key];
  if (limit === Infinity) return ok(true);
  const current = ({
    sites: usage.sites, pagesPerSite: usage.pages, monthlyPageViews: usage.monthlyPageViews,
    storageMb: usage.storageMb, products: usage.products, staffSeats: usage.staffSeats,
    aiCreditsPerMonth: usage.aiCreditsUsed, customDomains: usage.customDomains,
  } as Record<keyof PlanLimits, number>)[key];

  if (current + amount > limit) {
    return fail(err('PLAN_LIMIT_REACHED',
      `the ${plan.name} plan includes ${limit} ${String(key).replace(/([A-Z])/g, ' $1').toLowerCase()}; you are using ${current}`));
  }
  return ok(true);
}

export interface Subscription {
  id: string;
  orgId: OrgId;
  planId: string;
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'paused';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd?: boolean;
  trialEndsAt?: string;
}

/**
 * Proration when changing plan mid-period.
 *
 * Charged on the unused remainder, computed in whole minor units and rounded
 * toward the customer. A cent in the merchant's favour on every upgrade is not
 * worth the support conversation it eventually causes.
 */
export function prorate(
  from: Plan,
  to: Plan,
  subscription: Subscription,
  now: Date,
): Result<{ creditMinor: number; chargeMinor: number; netMinor: number }> {
  if (from.currency !== to.currency) {
    return fail(err('VALIDATION_FAILED', 'plans must share a currency to be prorated'));
  }
  const start = Date.parse(subscription.currentPeriodStart);
  const end = Date.parse(subscription.currentPeriodEnd);
  if (!(end > start)) {
    return fail(err('VALIDATION_FAILED', 'the billing period is not a valid range'));
  }

  const total = end - start;
  const remaining = Math.max(0, Math.min(total, end - now.getTime()));
  const fraction = remaining / total;

  const creditMinor = Math.ceil(from.priceMinor * fraction);
  const chargeMinor = Math.floor(to.priceMinor * fraction);
  return ok({ creditMinor, chargeMinor, netMinor: chargeMinor - creditMinor });
}

/* ------------------------------------------------------------------ */
/* Agency roll-up                                                      */
/* ------------------------------------------------------------------ */

export interface SiteHealth {
  siteId: SiteId;
  name: string;
  /** Domain, publish and certificate state rolled into one signal. */
  issues: { severity: 'critical' | 'warning'; message: string }[];
  lastPublishedAt?: string;
  totals: Totals;
}

export interface AgencyRollup {
  sites: SiteHealth[];
  totals: Totals;
  criticalCount: number;
  warningCount: number;
}

/**
 * Roll many sites into one view.
 *
 * Sorted by how much attention each needs rather than alphabetically. An
 * agency with sixty sites opens this to find the two that are broken, and an
 * alphabetical list buries them.
 */
export function rollUp(sites: SiteHealth[]): AgencyRollup {
  const totals = sites.reduce<Totals>((acc, site) => ({
    views: acc.views + site.totals.views,
    visitors: acc.visitors + site.totals.visitors,
    forms: acc.forms + site.totals.forms,
    bookings: acc.bookings + site.totals.bookings,
    orders: acc.orders + site.totals.orders,
    revenueMinor: acc.revenueMinor + site.totals.revenueMinor,
  }), { ...EMPTY });

  const severity = (site: SiteHealth) =>
    site.issues.filter((i) => i.severity === 'critical').length * 1000
    + site.issues.filter((i) => i.severity === 'warning').length;

  return {
    sites: [...sites].sort((a, b) => severity(b) - severity(a) || a.name.localeCompare(b.name)),
    totals,
    criticalCount: sites.reduce((n, s) => n + s.issues.filter((i) => i.severity === 'critical').length, 0),
    warningCount: sites.reduce((n, s) => n + s.issues.filter((i) => i.severity === 'warning').length, 0),
  };
}

/**
 * Visitor hash for a day.
 *
 * Salted per site and per day so the same person on two merchant sites, or on
 * the same site tomorrow, produces unrelated values. Without the daily
 * rotation this is a durable identifier — a cookie by another name, with none
 * of the disclosure.
 */
export function visitorHash(
  ip: string,
  userAgent: string,
  siteSalt: string,
  day: string,
  sha256: (input: string) => string,
): string {
  return sha256(`${day}|${siteSalt}|${ip}|${userAgent}`).slice(0, 32);
}
