/**
 * In-memory state for the business modules.
 *
 * Kept beside AppStore rather than inside it: pages, brand and the knowledge
 * graph are the *site*, while orders, bookings and contacts are the *business
 * running on it*. They have different lifecycles — a redesign replaces every
 * page and must not touch a single order — and separating them at the store
 * boundary makes that impossible to get wrong by accident.
 *
 * Seeded with a small, coherent set of demo data so every screen has something
 * real to show. The seed is deterministic, so the demo and the tests agree.
 */

import { asId, type OrgId, type SiteId, type UserId } from '../core/ids.ts';
import { money, type Money } from '../commerce/money.ts';
import type { InventoryMovement, Product, Variant } from '../commerce/catalog.ts';
import type { Order } from '../commerce/orders.ts';
import type { BookableService, Booking, EventDefinition, Registration, Resource } from '../scheduling/bookings.ts';
import type { Schedule } from '../scheduling/availability.ts';
import type { Form, Submission } from '../crm/forms.ts';
import type { Activity, Contact, Deal, PipelineStage } from '../crm/contacts.ts';
import type { Automation, AutomationRun } from '../automation/engine.ts';
import type { Domain, PublishedVersion, Redirect } from '../publishing/domains.ts';
import type { MetricEvent, Plan, Subscription } from '../analytics/metrics.ts';

export const CURRENCY = 'CAD';
const m = (n: number): Money => money(n, CURRENCY);

export interface BusinessState {
  products: Product[];
  movements: InventoryMovement[];
  orders: Order[];
  services: BookableService[];
  resources: Resource[];
  bookings: Booking[];
  events: EventDefinition[];
  registrations: Registration[];
  forms: Form[];
  submissions: Submission[];
  contacts: Contact[];
  activities: Activity[];
  stages: PipelineStage[];
  deals: Deal[];
  automations: Automation[];
  runs: AutomationRun[];
  domains: Domain[];
  redirects: Redirect[];
  versions: PublishedVersion[];
  metrics: MetricEvent[];
  plan: Plan;
  subscription: Subscription;
}

/** Deterministic ids, so a seeded demo matches a seeded test. */
export function counterIds(): (prefix: string) => string {
  let n = 0;
  return (prefix) => `${prefix}_${String(++n).padStart(6, '0')}`;
}

const TZ = 'America/Halifax';

const officeHours: Schedule = {
  timezone: TZ,
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday: weekday as 1, start: 8 * 60, end: 17 * 60 })),
};

export function seedBusiness(
  siteId: SiteId,
  orgId: OrgId,
  userId: UserId,
  now: Date,
): BusinessState {
  const id = counterIds();
  const iso = now.toISOString();

  const variant = (over: Partial<Variant> & { id: string; price: Money }): Variant => ({
    productId: 'prd_shingle', optionValues: [], requiresShipping: true,
    trackInventory: true, allowBackorder: false, position: 0, ...over,
  });

  const products: Product[] = [
    {
      id: 'prd_shingle', siteId, title: 'Architectural shingle bundle', handle: 'architectural-shingle',
      status: 'active', tags: ['roofing', 'materials'],
      options: [{ name: 'Colour', values: ['Charcoal', 'Weathered Wood', 'Slate'] }],
      variants: [
        variant({ id: 'var_char', optionValues: ['Charcoal'], sku: 'SH-CHAR', price: m(4200), position: 0 }),
        variant({ id: 'var_wood', optionValues: ['Weathered Wood'], sku: 'SH-WOOD', price: m(4200), position: 1 }),
        variant({ id: 'var_slate', optionValues: ['Slate'], sku: 'SH-SLATE', price: m(4500), compareAtPrice: m(4900), position: 2 }),
      ],
      imageAssetIds: [], collectionIds: [], updatedAt: iso,
    },
    {
      id: 'prd_ridge', siteId, title: 'Ridge vent, 4ft', handle: 'ridge-vent',
      status: 'active', tags: ['roofing'], options: [],
      variants: [variant({ id: 'var_ridge', productId: 'prd_ridge', sku: 'RV-4', price: m(3800) })],
      imageAssetIds: [], collectionIds: [], updatedAt: iso,
    },
    {
      id: 'prd_guide', siteId, title: 'Roof maintenance guide (PDF)', handle: 'maintenance-guide',
      status: 'active', tags: ['guide'], options: [],
      variants: [variant({
        id: 'var_guide', productId: 'prd_guide', sku: 'GUIDE', price: m(0),
        requiresShipping: false, trackInventory: false,
      })],
      imageAssetIds: [], collectionIds: [], updatedAt: iso,
    },
  ];

  const movements: InventoryMovement[] = [
    { id: id('inv'), siteId, variantId: 'var_char', locationId: 'loc_yard', delta: 140, reason: 'received', createdAt: iso },
    { id: id('inv'), siteId, variantId: 'var_wood', locationId: 'loc_yard', delta: 60, reason: 'received', createdAt: iso },
    { id: id('inv'), siteId, variantId: 'var_slate', locationId: 'loc_yard', delta: 4, reason: 'received', createdAt: iso },
    { id: id('inv'), siteId, variantId: 'var_ridge', locationId: 'loc_yard', delta: 0, reason: 'stock_take', createdAt: iso },
  ];

  const services: BookableService[] = [
    {
      id: 'svc_inspect', siteId, name: 'Roof inspection',
      description: 'A full survey with photographs and a fixed written quote.',
      durationMinutes: 60, price: m(0),
      resourceIds: ['res_dan', 'res_priya'],
      slotRules: {
        durationMinutes: 60, intervalMinutes: 30,
        bufferAfterMinutes: 30, minimumNoticeMinutes: 240, maximumAdvanceDays: 60,
      },
      intakeFields: [
        { key: 'address', label: 'Property address', required: true, type: 'text' },
        { key: 'storeys', label: 'How many storeys?', required: false, type: 'select', options: ['1', '2', '3+'] },
      ],
      cancellationPolicyHours: 24, active: true,
    },
    {
      id: 'svc_repair', siteId, name: 'Emergency repair call-out',
      durationMinutes: 120, depositAmount: m(15000),
      resourceIds: ['res_dan'],
      slotRules: { durationMinutes: 120, intervalMinutes: 60, minimumNoticeMinutes: 60, maximumAdvanceDays: 14 },
      cancellationPolicyHours: 4, active: true,
    },
  ];

  const resources: Resource[] = [
    { id: 'res_dan', siteId, name: 'Dan MacIsaac', kind: 'person', schedule: officeHours, capacity: 1, active: true },
    { id: 'res_priya', siteId, name: 'Priya Nair', kind: 'person', schedule: officeHours, capacity: 1, active: true },
  ];

  const events: EventDefinition[] = [{
    id: 'evt_workshop', siteId, title: 'Winter roof care workshop',
    description: 'What to check before the first freeze, and what to leave alone.',
    timezone: TZ, startDate: localDatePlus(now, 21), startMinute: 19 * 60, durationMinutes: 90,
    recurrence: { frequency: 'weekly', interval: 2, count: 4 },
    locationName: 'Acme Roofing yard', address: '14 Mill Road, Charlottetown',
    capacity: 24, waitlistEnabled: true, status: 'published',
    ticketTypes: [
      { id: 'tt_free', name: 'Free place', price: m(0), maxPerOrder: 4 },
      { id: 'tt_kit', name: 'Place plus starter kit', price: m(3500), quantity: 10, maxPerOrder: 2 },
    ],
  }];

  const forms: Form[] = [{
    id: 'frm_quote', siteId, name: 'Request a quote',
    fields: [
      { key: 'name', label: 'Your name', type: 'text', required: true, mapsTo: 'name' },
      { key: 'email', label: 'Email', type: 'email', required: true, mapsTo: 'email' },
      { key: 'phone', label: 'Phone', type: 'phone', mapsTo: 'phone' },
      { key: 'service', label: 'What do you need?', type: 'select', required: true,
        options: [
          { value: 'inspection', label: 'An inspection' },
          { value: 'repair', label: 'A repair' },
          { value: 'replacement', label: 'A full replacement' },
        ] },
      { key: 'message', label: 'Anything we should know?', type: 'textarea', max: 2000, mapsTo: 'message' },
      { key: 'optin', label: 'Email me seasonal maintenance reminders', type: 'consent',
        consentText: 'Email me seasonal maintenance reminders. Unsubscribe any time.' },
    ],
    successBehaviour: { kind: 'message', message: 'Thanks — we will be in touch within one working day.' },
    notifyEmails: ['dan@acmeroofing.ca'],
    tags: ['website lead'],
    spamProtection: { honeypotField: 'company_url', minimumSecondsToComplete: 4 },
    active: true, createdAt: iso,
  }];

  const stages: PipelineStage[] = [
    { id: 'stg_new', name: 'New enquiry', position: 0 },
    { id: 'stg_quoted', name: 'Quoted', position: 1 },
    { id: 'stg_scheduled', name: 'Scheduled', position: 2 },
    { id: 'stg_won', name: 'Won', position: 3, outcome: 'won' },
    { id: 'stg_lost', name: 'Lost', position: 4, outcome: 'lost' },
  ];

  const automations: Automation[] = [
    {
      id: 'aut_lead', siteId, name: 'Tag and notify on a new quote request',
      trigger: { kind: 'form_submitted', formId: 'frm_quote' },
      conditions: [], conditionMode: 'all',
      actions: [
        { kind: 'add_tag', tag: 'website lead' },
        { kind: 'create_deal', title: 'Quote request', stageId: 'stg_new' },
        { kind: 'send_email', to: 'staff', templateId: 'tpl_internal_lead' },
      ],
      enabled: true, maxRunsPerHour: 60, createdAt: iso, updatedAt: iso,
    },
    {
      id: 'aut_reminder', siteId, name: 'Remind the customer the day before',
      trigger: { kind: 'booking_upcoming' },
      conditions: [{ path: 'booking.status', operator: 'equals', value: 'confirmed' }],
      conditionMode: 'all',
      actions: [{ kind: 'send_email', to: 'contact', templateId: 'tpl_booking_reminder' }],
      enabled: true, reentryWindowMinutes: 720, createdAt: iso, updatedAt: iso,
    },
    {
      id: 'aut_bigjob', siteId, name: 'Flag large orders for a call',
      trigger: { kind: 'order_placed' },
      conditions: [{ path: 'order.total', operator: 'greater_than', value: 100000 }],
      conditionMode: 'all',
      actions: [
        { kind: 'add_tag', tag: 'large order' },
        { kind: 'create_task', title: 'Call to confirm delivery access', dueInDays: 1 },
      ],
      enabled: true, createdAt: iso, updatedAt: iso,
    },
  ];

  const domains: Domain[] = [{
    id: asId('dom_primary'), siteId, hostname: 'acmeroofing.ca', isPrimary: true,
    status: 'pending_dns', verificationToken: 'sidelio-verify-8f2c1a', forceHttps: true,
    createdAt: iso,
  }];

  const plan: Plan = {
    id: 'plan_pro', name: 'Pro', priceMinor: 4900, currency: CURRENCY, interval: 'month',
    features: ['Custom domain', 'Ecommerce', 'Bookings', 'Automations'],
    limits: {
      sites: 1, pagesPerSite: 50, monthlyPageViews: 100000, storageMb: 5000,
      products: 500, staffSeats: 5, aiCreditsPerMonth: 1000, customDomains: 3,
    },
  };

  const subscription: Subscription = {
    id: 'sub_1', orgId, planId: plan.id, status: 'trialing',
    currentPeriodStart: iso,
    currentPeriodEnd: new Date(now.getTime() + 30 * 86400000).toISOString(),
    trialEndsAt: new Date(now.getTime() + 14 * 86400000).toISOString(),
  };

  void userId;

  return {
    products, movements, orders: [],
    services, resources, bookings: [],
    events, registrations: [],
    forms, submissions: [],
    contacts: [], activities: [], stages, deals: [],
    automations, runs: [],
    domains, redirects: [], versions: [],
    metrics: seedMetrics(siteId, now),
    plan, subscription,
  };
}

/** Local YYYY-MM-DD, n days from a date, in the demo timezone. */
function localDatePlus(from: Date, days: number): string {
  const at = new Date(from.getTime() + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

/**
 * A fortnight of plausible traffic.
 *
 * Deterministic rather than random: an analytics screen that changes every
 * reload is impossible to test and impossible to demo.
 */
function seedMetrics(siteId: SiteId, now: Date): MetricEvent[] {
  const paths = ['/', '/services', '/about', '/contact', '/services/roof-replacement'];
  const referrers = [
    undefined, 'https://www.google.com/', 'https://www.google.com/',
    'https://www.facebook.com/', 'https://acmeroofing.ca/services',
  ];
  const out: MetricEvent[] = [];

  for (let day = 13; day >= 0; day--) {
    const dayStart = now.getTime() - day * 86400000;
    // A weekday/weekend shape, so the chart looks like a real business.
    const weekday = new Date(dayStart).getUTCDay();
    const base = weekday === 0 || weekday === 6 ? 14 : 38;

    for (let i = 0; i < base; i++) {
      const at = new Date(dayStart + ((i * 37) % 24) * 3600000 + ((i * 13) % 60) * 60000);
      out.push({
        siteId, kind: 'page_view', at: at.toISOString(),
        path: paths[(i + day) % paths.length] as string,
        ...(referrers[(i * 3 + day) % referrers.length]
          ? { referrer: referrers[(i * 3 + day) % referrers.length] as string }
          : {}),
        visitorHash: `v${day}_${i % Math.max(6, Math.floor(base / 2))}`,
        device: i % 3 === 0 ? 'desktop' : 'mobile',
        country: 'CA',
      });
    }
    if (day % 3 === 0) {
      out.push({ siteId, kind: 'form_submitted', at: new Date(dayStart + 50400000).toISOString(), path: '/contact' });
    }
    if (day % 5 === 0) {
      out.push({
        siteId, kind: 'order_placed', at: new Date(dayStart + 54000000).toISOString(),
        valueMinor: 12600 + day * 100, currency: CURRENCY,
      });
    }
  }
  return out;
}
