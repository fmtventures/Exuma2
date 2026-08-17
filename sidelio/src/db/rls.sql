-- Row-level security.
--
-- The application already checks permissions in code (src/core/permissions.ts).
-- These policies are the second, independent layer: even a SQL injection or a
-- forgotten WHERE clause cannot read another tenant's rows, because the
-- database itself will not return them.
--
-- The application connects as `sidelio_app`, which is NOT a superuser and does
-- NOT have BYPASSRLS. Every request sets three settings inside its transaction:
--
--   SET LOCAL sidelio.user_id      = 'usr_...';
--   SET LOCAL sidelio.org_id       = 'org_...';
--   SET LOCAL sidelio.site_ids     = 'site_a,site_b';   -- '' means org-wide
--
-- `SET LOCAL` is transaction-scoped, so a pooled connection cannot leak one
-- request's identity into the next.

-- DROP POLICY IF EXISTS is noisy on a first apply; the notices carry no signal.
SET client_min_messages = warning;

-- Roles are cluster-wide, not per-database, so plain CREATE ROLE aborts this
-- file on any second run — leaving policies and grants unapplied and the
-- database half-configured. Every statement below is written to be re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sidelio_app') THEN
    CREATE ROLE sidelio_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sidelio_migrator') THEN
    CREATE ROLE sidelio_migrator NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Session helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_org() RETURNS text AS $$
  SELECT nullif(current_setting('sidelio.org_id', true), '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS text AS $$
  SELECT nullif(current_setting('sidelio.user_id', true), '');
$$ LANGUAGE sql STABLE;

-- Empty means "org-wide access"; otherwise the member is confined to a list.
CREATE OR REPLACE FUNCTION current_site_ids() RETURNS text[] AS $$
  SELECT CASE
    WHEN coalesce(current_setting('sidelio.site_ids', true), '') = '' THEN NULL
    ELSE string_to_array(current_setting('sidelio.site_ids', true), ',')
  END;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION can_reach_site(target_site_id text) RETURNS boolean AS $$
  SELECT current_site_ids() IS NULL OR target_site_id = ANY (current_site_ids());
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Policy generation
-- ---------------------------------------------------------------------------

-- Applied to every table carrying both org_id and site_id.
DO $$
DECLARE
  t text;
  site_scoped text[] := ARRAY[
    'pages','navigations','collections','records','kg_entities','kg_facts',
    'kg_relationships','import_attestations','import_jobs','import_pages',
    'assets','change_sets','site_versions','forms','form_submissions',
    'domains','redirects','webhooks'
  ];
BEGIN
  FOREACH t IN ARRAY site_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_tenant_isolation ON %1$I', t);
    EXECUTE format($p$
      CREATE POLICY %1$I_tenant_isolation ON %1$I
        FOR ALL
        TO sidelio_app
        USING (org_id = current_org() AND can_reach_site(site_id))
        WITH CHECK (org_id = current_org() AND can_reach_site(site_id))
    $p$, t);
  END LOOP;
END $$;

-- Tables scoped to an organization but not to a single site.
DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY['sites','memberships','integrations','ai_usage','audit_events'];
BEGIN
  FOREACH t IN ARRAY org_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- `sites` needs its own rule: the site-id restriction applies to `id`, not to
-- a `site_id` column.
DROP POLICY IF EXISTS sites_tenant_isolation ON sites;
CREATE POLICY sites_tenant_isolation ON sites
  FOR ALL TO sidelio_app
  USING (org_id = current_org() AND can_reach_site(id))
  WITH CHECK (org_id = current_org() AND can_reach_site(id));

DROP POLICY IF EXISTS memberships_tenant_isolation ON memberships;
CREATE POLICY memberships_tenant_isolation ON memberships
  FOR ALL TO sidelio_app
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- Integrations may be org-wide (site_id IS NULL) or site-scoped.
DROP POLICY IF EXISTS integrations_tenant_isolation ON integrations;
CREATE POLICY integrations_tenant_isolation ON integrations
  FOR ALL TO sidelio_app
  USING (org_id = current_org() AND (site_id IS NULL OR can_reach_site(site_id)))
  WITH CHECK (org_id = current_org() AND (site_id IS NULL OR can_reach_site(site_id)));

DROP POLICY IF EXISTS ai_usage_tenant_isolation ON ai_usage;
CREATE POLICY ai_usage_tenant_isolation ON ai_usage
  FOR ALL TO sidelio_app
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- ---------------------------------------------------------------------------
-- Audit log: readable within the org, append-only for everyone
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS audit_events_read ON audit_events;
CREATE POLICY audit_events_read ON audit_events
  FOR SELECT TO sidelio_app
  USING (org_id = current_org());

DROP POLICY IF EXISTS audit_events_append ON audit_events;
CREATE POLICY audit_events_append ON audit_events
  FOR INSERT TO sidelio_app
  WITH CHECK (org_id = current_org());

-- No UPDATE or DELETE policy exists, so with FORCE RLS enabled the application
-- role cannot modify or remove an audit record at all. Retention is handled by
-- a separate maintenance role on a schedule.
REVOKE UPDATE, DELETE ON audit_events FROM sidelio_app;

-- ---------------------------------------------------------------------------
-- Users and organizations
-- ---------------------------------------------------------------------------

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- A user can always see themselves, plus anyone sharing an org with them.
DROP POLICY IF EXISTS users_self_and_colleagues ON users;
CREATE POLICY users_self_and_colleagues ON users
  FOR SELECT TO sidelio_app
  USING (
    id = current_user_id()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id AND m.org_id = current_org()
    )
  );

DROP POLICY IF EXISTS users_self_update ON users;
CREATE POLICY users_self_update ON users
  FOR UPDATE TO sidelio_app
  USING (id = current_user_id())
  WITH CHECK (id = current_user_id());

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organizations_own ON organizations;
CREATE POLICY organizations_own ON organizations
  FOR ALL TO sidelio_app
  USING (id = current_org())
  WITH CHECK (id = current_org());

-- Support sessions are readable only by the staff member they belong to.
ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_sessions_own ON support_sessions;
CREATE POLICY support_sessions_own ON support_sessions
  FOR ALL TO sidelio_app
  USING (user_id = current_user_id())
  WITH CHECK (user_id = current_user_id());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO sidelio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sidelio_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sidelio_app;

-- Re-apply the audit restriction after the blanket grant above.
REVOKE UPDATE, DELETE ON audit_events FROM sidelio_app;

-- Schema changes belong to the migrator, never to the request path.
GRANT ALL ON SCHEMA public TO sidelio_migrator;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

-- Run in CI: every table holding tenant data must have RLS forced. A new table
-- added without a policy fails this check rather than silently leaking.
CREATE OR REPLACE FUNCTION verify_rls_coverage()
RETURNS TABLE (table_name text, problem text) AS $$
  SELECT c.relname::text,
         CASE
           WHEN NOT c.relrowsecurity THEN 'row level security is not enabled'
           WHEN NOT c.relforcerowsecurity THEN 'row level security is not forced'
           ELSE 'no policy defined'
         END
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policy p ON p.polrelid = c.oid
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND (
      EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name IN ('org_id','site_id')
      )
      OR c.relname IN ('users','organizations','support_sessions')
    )
  GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
  HAVING NOT c.relrowsecurity
      OR NOT c.relforcerowsecurity
      OR count(p.polname) = 0;
$$ LANGUAGE sql STABLE;
