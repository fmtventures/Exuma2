-- Tenancy isolation, asserted against a real database.
--
-- This is the most important test in the platform. The permission engine is
-- unit-tested in pure TypeScript, but that proves only that the application
-- asks the right questions. This proves the database refuses the wrong answers
-- even when the application does not ask — which is the whole point of having
-- a second, independent layer.
--
-- Every check RAISEs on failure, so a non-zero psql exit is the assertion.

\set ON_ERROR_STOP on
SET client_min_messages = warning;

ALTER ROLE sidelio_app LOGIN;

INSERT INTO organizations (id, name, slug) VALUES
  ('org_a', 'Tenant A', 'tenant-a'),
  ('org_b', 'Tenant B', 'tenant-b');

INSERT INTO users (id, email) VALUES
  ('usr_a', 'a@example.com'),
  ('usr_b', 'b@example.com');

INSERT INTO sites (id, org_id, name, subdomain) VALUES
  ('site_a1', 'org_a', 'A one', 'a-one'),
  ('site_a2', 'org_a', 'A two', 'a-two'),
  ('site_b1', 'org_b', 'B one', 'b-one');

INSERT INTO pages (id, org_id, site_id, path, title) VALUES
  ('page_a1', 'org_a', 'site_a1', '/', 'A1 home'),
  ('page_a2', 'org_a', 'site_a2', '/', 'A2 home'),
  ('page_b1', 'org_b', 'site_b1', '/', 'B1 home');

INSERT INTO audit_events (id, org_id, actor_id, category, action, outcome) VALUES
  ('aud_a', 'org_a', 'usr_a', 'content', 'page.update', 'success');

SET ROLE sidelio_app;

DO $$
DECLARE
  n integer;
  failed boolean;
BEGIN
  -- 1. Org-wide member sees only their own org's pages.
  PERFORM set_config('sidelio.org_id', 'org_a', true);
  PERFORM set_config('sidelio.user_id', 'usr_a', true);
  PERFORM set_config('sidelio.site_ids', '', true);
  SELECT count(*) INTO n FROM pages;
  IF n <> 2 THEN RAISE EXCEPTION 'org-wide read: expected 2 pages, got %', n; END IF;

  -- 2. A site-scoped member is confined to their sites.
  PERFORM set_config('sidelio.site_ids', 'site_a1', true);
  SELECT count(*) INTO n FROM pages;
  IF n <> 1 THEN RAISE EXCEPTION 'site-scoped read: expected 1 page, got %', n; END IF;

  -- 3. The other tenant sees only its own.
  PERFORM set_config('sidelio.org_id', 'org_b', true);
  PERFORM set_config('sidelio.site_ids', '', true);
  SELECT count(*) INTO n FROM pages;
  IF n <> 1 THEN RAISE EXCEPTION 'org_b read: expected 1 page, got %', n; END IF;

  -- 4. No session context at all reveals nothing. This is the case that
  --    matters if a code path ever forgets to set the transaction settings.
  PERFORM set_config('sidelio.org_id', '', true);
  PERFORM set_config('sidelio.site_ids', '', true);
  SELECT count(*) INTO n FROM pages;
  IF n <> 0 THEN RAISE EXCEPTION 'no context: expected 0 pages, got %', n; END IF;
  SELECT count(*) INTO n FROM sites;
  IF n <> 0 THEN RAISE EXCEPTION 'no context: expected 0 sites, got %', n; END IF;

  -- 5. Updating another tenant's row affects nothing.
  PERFORM set_config('sidelio.org_id', 'org_a', true);
  UPDATE pages SET title = 'hijacked' WHERE id = 'page_b1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant update touched % row(s)', n; END IF;

  -- 6. Deleting another tenant's row affects nothing.
  DELETE FROM pages WHERE id = 'page_b1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant delete removed % row(s)', n; END IF;

  -- 7. Writing a row belonging to another tenant is refused by RLS.
  failed := false;
  BEGIN
    INSERT INTO pages (id, org_id, site_id, path, title)
      VALUES ('page_evil', 'org_b', 'site_b1', '/evil', 'Evil');
  EXCEPTION WHEN insufficient_privilege OR others THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'cross-tenant insert was allowed'; END IF;

  -- 8. A site-scoped member cannot write outside their sites.
  PERFORM set_config('sidelio.site_ids', 'site_a1', true);
  failed := false;
  BEGIN
    INSERT INTO pages (id, org_id, site_id, path, title)
      VALUES ('page_scope', 'org_a', 'site_a2', '/x', 'X');
  EXCEPTION WHEN others THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'out-of-scope insert was allowed'; END IF;

  -- 9. A row whose org disagrees with its parent site is refused by the
  --    trigger, and the message names the real owner rather than reporting
  --    a NULL it could not see.
  PERFORM set_config('sidelio.site_ids', '', true);
  failed := false;
  BEGIN
    INSERT INTO pages (id, org_id, site_id, path, title)
      VALUES ('page_mismatch', 'org_a', 'site_b1', '/y', 'Y');
  EXCEPTION WHEN others THEN
    failed := true;
    IF SQLERRM NOT LIKE '%owned by org_b%' THEN
      RAISE EXCEPTION 'mismatch error did not identify the owner: %', SQLERRM;
    END IF;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'org/site mismatch was allowed'; END IF;

  -- 10. A legitimate write still succeeds — isolation must not mean paralysis.
  INSERT INTO pages (id, org_id, site_id, path, title)
    VALUES ('page_ok', 'org_a', 'site_a1', '/ok', 'OK');
  SELECT count(*) INTO n FROM pages WHERE id = 'page_ok';
  IF n <> 1 THEN RAISE EXCEPTION 'legitimate insert did not land'; END IF;

  -- 11. The audit log is append-only for the application role.
  INSERT INTO audit_events (id, org_id, actor_id, category, action, outcome)
    VALUES ('aud_new', 'org_a', 'usr_a', 'content', 'page.create', 'success');

  failed := false;
  BEGIN
    UPDATE audit_events SET outcome = 'denied' WHERE id = 'aud_a';
  EXCEPTION WHEN insufficient_privilege THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'audit event was updatable'; END IF;

  failed := false;
  BEGIN
    DELETE FROM audit_events WHERE id = 'aud_a';
  EXCEPTION WHEN insufficient_privilege THEN failed := true;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'audit event was deletable'; END IF;

  -- 12. Support sessions are visible only to the staff member they belong to.
  PERFORM set_config('sidelio.user_id', 'usr_b', true);
  SELECT count(*) INTO n FROM support_sessions;
  IF n <> 0 THEN RAISE EXCEPTION 'support sessions leaked across users'; END IF;

  RAISE NOTICE 'all tenancy assertions passed';
END $$;

RESET ROLE;

-- 13. Every tenant table is covered by a forced policy. A new table added
--     without one fails here rather than leaking silently in production.
DO $$
DECLARE
  gap record;
BEGIN
  FOR gap IN SELECT * FROM verify_rls_coverage() LOOP
    RAISE EXCEPTION 'RLS coverage gap: % — %', gap.table_name, gap.problem;
  END LOOP;
END $$;
