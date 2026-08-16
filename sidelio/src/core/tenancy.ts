import type { OrgId, SiteId, UserId } from './ids.ts';

/**
 * Tenancy model.
 *
 * Organization
 *   └── Site (1..n)          — a published website, its own domain + content
 *        └── Environment      — draft / preview / production
 *
 * An Organization is the billing and ownership boundary. An agency is simply
 * an Organization that owns many Sites; there is no separate "agency" entity,
 * which keeps a solo business and a 200-site agency on identical code paths.
 *
 * Every persisted row in the platform carries `org_id`, and every row scoped
 * to a website also carries `site_id`. Postgres RLS (see src/db/rls.sql) keys
 * off those two columns, so tenancy is enforced by the database rather than by
 * remembering to add a WHERE clause.
 */

export type Environment = 'draft' | 'preview' | 'production';

export type SiteStatus =
  | 'provisioning'
  | 'importing'
  | 'draft'
  | 'published'
  | 'suspended'
  | 'archived';

export interface Organization {
  id: OrgId;
  name: string;
  slug: string;
  plan: PlanCode;
  /** Agencies get client-facing restrictions such as locked brand kits. */
  isAgency: boolean;
  createdAt: string;
  suspendedAt?: string;
}

export type PlanCode = 'free' | 'starter' | 'business' | 'commerce' | 'agency' | 'enterprise';

export interface PlanLimits {
  sites: number;
  pagesPerSite: number;
  storageBytes: number;
  aiCreditsPerMonth: number;
  customDomains: number;
  seats: number;
  /** Feature modules unlocked by the plan; see MODULE_KEYS. */
  modules: readonly ModuleKey[];
}

/**
 * Admin modules. Every module is optional so a small business is not shown a
 * 40-item sidebar; `Site.enabledModules` decides what renders.
 */
export const MODULE_KEYS = [
  'pages', 'navigation', 'content', 'media', 'ai_studio', 'forms', 'leads', 'crm',
  'products', 'orders', 'customers', 'payments', 'bookings', 'calendar', 'events',
  'blog', 'team', 'testimonials', 'reviews', 'promotions', 'banners', 'popups',
  'email', 'sms', 'social', 'seo', 'analytics', 'integrations', 'apps',
  'automations', 'domains', 'hosting', 'security', 'users', 'roles', 'billing',
  'backups', 'versions', 'audit_log', 'settings',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/** Modules that are always present — hiding them would strand the site owner. */
export const CORE_MODULES: readonly ModuleKey[] = [
  'pages', 'navigation', 'media', 'settings', 'users', 'versions', 'audit_log', 'domains',
];

export const PLAN_LIMITS: Record<PlanCode, PlanLimits> = {
  free: {
    sites: 1, pagesPerSite: 5, storageBytes: 500 * 1024 ** 2, aiCreditsPerMonth: 200,
    customDomains: 0, seats: 1,
    modules: [...CORE_MODULES, 'forms', 'ai_studio', 'seo'],
  },
  starter: {
    sites: 1, pagesPerSite: 50, storageBytes: 5 * 1024 ** 3, aiCreditsPerMonth: 2_000,
    customDomains: 1, seats: 3,
    modules: [...CORE_MODULES, 'forms', 'leads', 'ai_studio', 'seo', 'analytics', 'blog',
      'team', 'testimonials', 'banners', 'content', 'integrations'],
  },
  business: {
    sites: 3, pagesPerSite: 300, storageBytes: 50 * 1024 ** 3, aiCreditsPerMonth: 10_000,
    customDomains: 3, seats: 10,
    modules: MODULE_KEYS.filter((m) => m !== 'sms'),
  },
  commerce: {
    sites: 3, pagesPerSite: 1_000, storageBytes: 200 * 1024 ** 3, aiCreditsPerMonth: 25_000,
    customDomains: 5, seats: 20, modules: MODULE_KEYS,
  },
  agency: {
    sites: 100, pagesPerSite: 1_000, storageBytes: 1024 ** 4, aiCreditsPerMonth: 100_000,
    customDomains: 100, seats: 50, modules: MODULE_KEYS,
  },
  enterprise: {
    sites: Number.POSITIVE_INFINITY, pagesPerSite: Number.POSITIVE_INFINITY,
    storageBytes: Number.POSITIVE_INFINITY, aiCreditsPerMonth: Number.POSITIVE_INFINITY,
    customDomains: Number.POSITIVE_INFINITY, seats: Number.POSITIVE_INFINITY,
    modules: MODULE_KEYS,
  },
};

export interface Site {
  id: SiteId;
  orgId: OrgId;
  name: string;
  /** Always-available Sidelio subdomain, e.g. `acme-roofing.sidelio.site`. */
  subdomain: string;
  primaryDomain?: string;
  status: SiteStatus;
  enabledModules: ModuleKey[];
  /** Agency-managed sites can have brand tokens locked against client edits. */
  brandLocked: boolean;
  locale: string;
  additionalLocales: string[];
  createdAt: string;
  publishedAt?: string;
}

export interface User {
  id: UserId;
  email: string;
  name?: string;
  /** Sidelio staff flag — never granted through the customer-facing API. */
  isPlatformStaff: boolean;
  createdAt: string;
}

/**
 * A membership grants a role either across the whole organization or against a
 * specific subset of sites. Site-scoped memberships are what let an agency give
 * a client access to exactly one website.
 */
export interface Membership {
  orgId: OrgId;
  userId: UserId;
  role: RoleName;
  /** `null` = org-wide. Non-empty array = restricted to those sites. */
  siteIds: SiteId[] | null;
  createdAt: string;
}

export type RoleName =
  | 'platform_admin'
  | 'org_owner'
  | 'org_admin'
  | 'site_admin'
  | 'editor'
  | 'contributor'
  | 'analyst'
  | 'billing_manager'
  | 'client_viewer';

/** Resolve which admin modules should render for a site under a plan. */
export function visibleModules(site: Site, plan: PlanCode): ModuleKey[] {
  const allowed = new Set(PLAN_LIMITS[plan].modules);
  const enabled = new Set(site.enabledModules);
  return MODULE_KEYS.filter(
    (m) => allowed.has(m) && (enabled.has(m) || CORE_MODULES.includes(m)),
  );
}
