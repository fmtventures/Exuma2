import { describe, expect, it } from 'vitest';
import { asId, type OrgId, type SiteId, type UserId } from '../src/core/ids.ts';
import {
  accessibleSites, can, canEditBrand, decide, effectivePermissions,
  ROLE_PERMISSIONS, type Actor,
} from '../src/core/permissions.ts';
import type { Membership, Site } from '../src/core/tenancy.ts';

const ORG_A = asId<OrgId>('org_a');
const ORG_B = asId<OrgId>('org_b');
const SITE_1 = asId<SiteId>('site_1');
const SITE_2 = asId<SiteId>('site_2');
const USER = asId<UserId>('usr_1');

function membership(over: Partial<Membership> = {}): Membership {
  return {
    orgId: ORG_A, userId: USER, role: 'editor', siteIds: null,
    createdAt: '2026-01-01T00:00:00Z', ...over,
  };
}

function actor(memberships: Membership[], over: Partial<Actor> = {}): Actor {
  return { userId: USER, isPlatformStaff: false, memberships, ...over };
}

function site(over: Partial<Site> = {}): Site {
  return {
    id: SITE_1, orgId: ORG_A, name: 'Acme', subdomain: 'acme', status: 'draft',
    enabledModules: [], brandLocked: false, locale: 'en', additionalLocales: [],
    createdAt: '2026-01-01T00:00:00Z', ...over,
  };
}

describe('permission engine', () => {
  it('grants a permission held by the role', () => {
    const a = actor([membership({ role: 'site_admin' })]);
    expect(can(a, 'page:publish', { orgId: ORG_A, siteId: SITE_1 })).toBe(true);
  });

  it('denies a permission the role lacks', () => {
    const a = actor([membership({ role: 'contributor' })]);
    expect(can(a, 'page:publish', { orgId: ORG_A, siteId: SITE_1 })).toBe(false);
  });

  it('never allows access to another organization', () => {
    const a = actor([membership({ role: 'org_owner' })]);
    const decision = decide(a, 'site:read', { orgId: ORG_B, siteId: SITE_1 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('no membership');
  });

  it('confines a site-scoped membership to its own sites', () => {
    const a = actor([membership({ role: 'site_admin', siteIds: [SITE_1] })]);
    expect(can(a, 'page:update', { orgId: ORG_A, siteId: SITE_1 })).toBe(true);
    expect(can(a, 'page:update', { orgId: ORG_A, siteId: SITE_2 })).toBe(false);
  });

  it('does not let a site-scoped membership act org-wide', () => {
    const a = actor([membership({ role: 'org_admin', siteIds: [SITE_1] })]);
    expect(can(a, 'user:invite', { orgId: ORG_A })).toBe(false);
  });

  it('combines multiple memberships', () => {
    const a = actor([
      membership({ role: 'analyst' }),
      membership({ role: 'site_admin', siteIds: [SITE_1] }),
    ]);
    expect(can(a, 'page:publish', { orgId: ORG_A, siteId: SITE_1 })).toBe(true);
    expect(can(a, 'page:publish', { orgId: ORG_A, siteId: SITE_2 })).toBe(false);
    expect(can(a, 'analytics:read', { orgId: ORG_A, siteId: SITE_2 })).toBe(true);
  });

  describe('platform staff', () => {
    it('is denied without an active support session', () => {
      const a = actor([], { isPlatformStaff: true });
      expect(can(a, 'site:read', { orgId: ORG_A })).toBe(false);
    });

    it('is allowed within a live, correctly-scoped session', () => {
      const a = actor([], {
        isPlatformStaff: true,
        supportSession: { orgId: ORG_A, reason: 'ticket-4821', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      });
      expect(can(a, 'site:read', { orgId: ORG_A })).toBe(true);
      expect(can(a, 'site:read', { orgId: ORG_B })).toBe(false);
    });

    it('is denied once the session expires', () => {
      const a = actor([], {
        isPlatformStaff: true,
        supportSession: { orgId: ORG_A, reason: 'ticket-4821', expiresAt: new Date(Date.now() - 1000).toISOString() },
      });
      expect(can(a, 'site:read', { orgId: ORG_A })).toBe(false);
    });
  });

  describe('brand locks', () => {
    it('allows editing an unlocked kit', () => {
      const a = actor([membership({ role: 'site_admin' })]);
      expect(canEditBrand(a, site()).ok).toBe(true);
    });

    it('blocks a site admin on a locked kit', () => {
      const a = actor([membership({ role: 'site_admin' })]);
      const result = canEditBrand(a, site({ brandLocked: true }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    });

    it('lets an org owner override the lock', () => {
      const a = actor([membership({ role: 'org_owner' })]);
      expect(canEditBrand(a, site({ brandLocked: true })).ok).toBe(true);
    });
  });

  it('lists only reachable sites', () => {
    const a = actor([membership({ role: 'editor', siteIds: [SITE_2] })]);
    const sites = [site({ id: SITE_1 }), site({ id: SITE_2 })];
    expect(accessibleSites(a, ORG_A, sites).map((s) => s.id)).toEqual([SITE_2]);
  });

  it('gives client_viewer read-only access', () => {
    const a = actor([membership({ role: 'client_viewer' })]);
    const perms = effectivePermissions(a, { orgId: ORG_A, siteId: SITE_1 });
    expect(perms).toContain('site:read');
    expect(perms.some((p) => p.includes(':update') || p.includes(':delete') || p.includes(':publish'))).toBe(false);
  });

  it('never grants impersonation outside platform_admin', () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === 'platform_admin') continue;
      expect(perms).not.toContain('platform:impersonate');
    }
  });

  it('keeps billing:manage away from org_admin', () => {
    const a = actor([membership({ role: 'org_admin' })]);
    expect(can(a, 'billing:manage', { orgId: ORG_A })).toBe(false);
    expect(can(a, 'user:invite', { orgId: ORG_A })).toBe(true);
  });
});
