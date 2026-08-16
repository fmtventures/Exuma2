import { err, SidelioError } from './errors.ts';
import { fail, ok, type Result } from './result.ts';
import type { OrgId, SiteId, UserId } from './ids.ts';
import type { Membership, RoleName, Site } from './tenancy.ts';

/**
 * Permission model.
 *
 * Permissions are `resource:action` strings. Roles map to permission sets;
 * memberships map users to roles within an org and optionally within a subset
 * of sites. Authorization is a pure function of (actor, permission, scope),
 * which makes it exhaustively testable and safe to mirror in the database RLS
 * policies and in the admin UI's "can I see this button" checks.
 *
 * Rules that hold regardless of role:
 *   1. An actor can never act outside their organization (except platform staff
 *      acting through an audited support session).
 *   2. A site-scoped membership can never reach a site outside its list.
 *   3. Destructive actions on published resources require an explicit
 *      permission, never an implied one.
 */

export const PERMISSIONS = [
  'site:read', 'site:create', 'site:update', 'site:delete', 'site:publish', 'site:transfer',
  'page:read', 'page:create', 'page:update', 'page:delete', 'page:publish',
  'content:read', 'content:create', 'content:update', 'content:delete', 'content:publish',
  'media:read', 'media:upload', 'media:update', 'media:delete',
  'ai:use', 'ai:apply_changeset', 'ai:configure',
  'import:create', 'import:read', 'import:apply',
  'form:read', 'form:update', 'submission:read', 'submission:export', 'submission:delete',
  'commerce:read', 'commerce:manage_catalog', 'commerce:manage_orders', 'commerce:refund',
  'booking:read', 'booking:manage',
  'event:read', 'event:manage',
  'domain:read', 'domain:manage',
  'integration:read', 'integration:manage', 'integration:manage_secrets',
  'automation:read', 'automation:manage',
  'analytics:read',
  'user:read', 'user:invite', 'user:update_role', 'user:remove',
  'billing:read', 'billing:manage',
  'brand:update', 'brand:unlock',
  'audit:read',
  'backup:read', 'backup:restore',
  'platform:impersonate',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

const CONTENT_EDITOR: readonly Permission[] = [
  'site:read',
  'page:read', 'page:create', 'page:update',
  'content:read', 'content:create', 'content:update',
  'media:read', 'media:upload', 'media:update',
  'ai:use',
  'form:read', 'submission:read',
  'event:read', 'event:manage',
  'booking:read',
  'commerce:read',
  'analytics:read',
];

export const ROLE_PERMISSIONS: Record<RoleName, readonly Permission[]> = {
  platform_admin: ALL,

  org_owner: ALL.filter((p) => p !== 'platform:impersonate'),

  org_admin: ALL.filter(
    (p) => !['platform:impersonate', 'billing:manage', 'site:transfer', 'site:delete', 'brand:unlock'].includes(p),
  ),

  site_admin: [
    ...CONTENT_EDITOR,
    'site:update', 'site:publish',
    'page:delete', 'page:publish',
    'content:delete', 'content:publish',
    'media:delete',
    'ai:apply_changeset',
    'import:create', 'import:read', 'import:apply',
    'form:update', 'submission:export', 'submission:delete',
    'commerce:manage_catalog', 'commerce:manage_orders',
    'booking:manage',
    'domain:read',
    'integration:read', 'integration:manage',
    'automation:read', 'automation:manage',
    'user:read', 'user:invite',
    'brand:update',
    'audit:read',
    'backup:read',
  ],

  editor: [...CONTENT_EDITOR, 'page:publish', 'content:publish', 'ai:apply_changeset', 'import:read'],

  /** Can draft but never publish — the safe default for junior staff. */
  contributor: CONTENT_EDITOR.filter((p) => !p.endsWith(':publish')),

  analyst: ['site:read', 'page:read', 'content:read', 'media:read', 'analytics:read', 'submission:read', 'commerce:read', 'event:read', 'booking:read'],

  billing_manager: ['site:read', 'billing:read', 'billing:manage', 'analytics:read'],

  client_viewer: ['site:read', 'page:read', 'content:read', 'media:read', 'analytics:read'],
};

/** The authenticated principal for a request. */
export interface Actor {
  userId: UserId;
  isPlatformStaff: boolean;
  memberships: Membership[];
  /** Set when platform staff act on a customer org through a support session. */
  supportSession?: { orgId: OrgId; reason: string; expiresAt: string };
}

export interface Scope {
  orgId: OrgId;
  siteId?: SiteId;
}

export interface AuthzDecision {
  allowed: boolean;
  reason: string;
  /** Roles that produced the grant — recorded on the audit event. */
  viaRoles: RoleName[];
}

function membershipsFor(actor: Actor, scope: Scope): Membership[] {
  return actor.memberships.filter((m) => {
    if (m.orgId !== scope.orgId) return false;
    if (m.siteIds === null) return true;
    if (!scope.siteId) return false; // site-scoped member cannot act org-wide
    return m.siteIds.includes(scope.siteId);
  });
}

/**
 * Core authorization check. Pure — no I/O — so it can be called freely in the
 * API layer, in background jobs, and in UI capability resolution.
 */
export function decide(actor: Actor, permission: Permission, scope: Scope): AuthzDecision {
  if (actor.isPlatformStaff) {
    const session = actor.supportSession;
    if (!session) {
      return { allowed: false, reason: 'platform staff require an active support session', viaRoles: [] };
    }
    if (session.orgId !== scope.orgId) {
      return { allowed: false, reason: 'support session is scoped to a different organization', viaRoles: [] };
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      return { allowed: false, reason: 'support session expired', viaRoles: [] };
    }
    return { allowed: true, reason: 'platform support session', viaRoles: ['platform_admin'] };
  }

  const relevant = membershipsFor(actor, scope);
  if (relevant.length === 0) {
    return { allowed: false, reason: 'no membership in scope', viaRoles: [] };
  }

  const granting = relevant.filter((m) => ROLE_PERMISSIONS[m.role].includes(permission));
  if (granting.length === 0) {
    return {
      allowed: false,
      reason: `role(s) ${relevant.map((m) => m.role).join(', ')} lack ${permission}`,
      viaRoles: relevant.map((m) => m.role),
    };
  }
  return { allowed: true, reason: 'granted by role', viaRoles: granting.map((m) => m.role) };
}

export function can(actor: Actor, permission: Permission, scope: Scope): boolean {
  return decide(actor, permission, scope).allowed;
}

/** Throwing variant for imperative call sites. */
export function assertCan(actor: Actor, permission: Permission, scope: Scope): void {
  const decision = decide(actor, permission, scope);
  if (!decision.allowed) {
    throw err('FORBIDDEN', `denied ${permission}: ${decision.reason}`, {
      userMessage: 'You do not have permission to perform this action.',
    });
  }
}

export function requireCan(
  actor: Actor,
  permission: Permission,
  scope: Scope,
): Result<AuthzDecision, SidelioError> {
  const decision = decide(actor, permission, scope);
  return decision.allowed
    ? ok(decision)
    : fail(err('FORBIDDEN', `denied ${permission}: ${decision.reason}`, {
        userMessage: 'You do not have permission to perform this action.',
      }));
}

/**
 * Brand-lock guard. An agency can lock a client's brand tokens; only a role
 * holding `brand:unlock` may override, and the override is always audited.
 */
export function canEditBrand(actor: Actor, site: Site): Result<true, SidelioError> {
  const scope: Scope = { orgId: site.orgId, siteId: site.id };
  const check = requireCan(actor, 'brand:update', scope);
  if (!check.ok) return check;
  if (site.brandLocked && !can(actor, 'brand:unlock', scope)) {
    return fail(err('FORBIDDEN', 'brand kit is locked by the managing organization', {
      userMessage: 'Your brand kit is locked by the agency that manages this site.',
    }));
  }
  return ok(true);
}

/** All permissions an actor holds in a scope — used to drive UI affordances. */
export function effectivePermissions(actor: Actor, scope: Scope): Permission[] {
  return PERMISSIONS.filter((p) => can(actor, p, scope));
}

/** Sites an actor can reach in an org, given the org's full site list. */
export function accessibleSites(actor: Actor, orgId: OrgId, sites: Site[]): Site[] {
  return sites.filter((s) => s.orgId === orgId && can(actor, 'site:read', { orgId, siteId: s.id }));
}
