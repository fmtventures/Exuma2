-- Sidelio Website Builder — core schema (PostgreSQL 15+)
--
-- Conventions that hold everywhere in this schema:
--
--  1. Every tenant-owned table carries `org_id`. Every site-owned table also
--     carries `site_id`. Row-level security keys off those columns (rls.sql),
--     so tenancy is enforced by the database rather than by remembering to
--     write a WHERE clause.
--  2. Ids are text with a type prefix (`site_01J9...`) rather than bare uuids,
--     so an id is self-describing in logs, URLs and audit records.
--  3. Content is stored as jsonb where the shape is user-defined (blocks, CMS
--     records, block props) and as columns where the platform queries it.
--  4. Nothing is hard-deleted that a user might want back; `archived_at` and
--     the version tables carry the history.

CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy search over content
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitive emails, slugs, hostnames

-- Semantic asset search ("photos of the team outside") needs pgvector, which
-- is not present in a stock Postgres. It is kept out of the core schema so a
-- plain instance can run the platform; apply src/db/optional-pgvector.sql to
-- switch it on. Without it, asset search falls back to tags and text, which
-- `searchAssets` already handles.

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TYPE plan_code AS ENUM ('free','starter','business','commerce','agency','enterprise');
CREATE TYPE site_status AS ENUM ('provisioning','importing','draft','published','suspended','archived');
CREATE TYPE role_name AS ENUM (
  'platform_admin','org_owner','org_admin','site_admin','editor',
  'contributor','analyst','billing_manager','client_viewer'
);

CREATE TABLE organizations (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  slug          citext UNIQUE NOT NULL,
  plan          plan_code NOT NULL DEFAULT 'free',
  is_agency     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  suspended_at  timestamptz
);

CREATE TABLE users (
  id                 text PRIMARY KEY,
  email              citext UNIQUE NOT NULL,
  name               text,
  is_platform_staff  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz
);

CREATE TABLE sites (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  subdomain        citext UNIQUE NOT NULL,
  primary_domain   citext UNIQUE,
  status           site_status NOT NULL DEFAULT 'provisioning',
  enabled_modules  text[] NOT NULL DEFAULT '{}',
  brand_locked     boolean NOT NULL DEFAULT false,
  locale           text NOT NULL DEFAULT 'en',
  additional_locales text[] NOT NULL DEFAULT '{}',
  brand_kit        jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  archived_at      timestamptz
);
CREATE INDEX sites_org_idx ON sites (org_id) WHERE archived_at IS NULL;

-- `site_ids IS NULL` means org-wide; a non-empty array restricts the member to
-- those sites. This is what lets an agency give a client exactly one site.
CREATE TABLE memberships (
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        role_name NOT NULL,
  site_ids    text[],
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text REFERENCES users(id),
  PRIMARY KEY (org_id, user_id, role)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- Platform staff may only act on a customer org through a time-boxed,
-- reason-tagged session. Every action taken under one is audited.
CREATE TABLE support_sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  CONSTRAINT support_session_bounded CHECK (expires_at > started_at)
);
CREATE INDEX support_sessions_active_idx ON support_sessions (user_id, org_id)
  WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------
-- Content
-- ---------------------------------------------------------------------------

CREATE TYPE page_status AS ENUM ('draft','published','scheduled','archived');

CREATE TABLE pages (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id        text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  path           text NOT NULL,
  title          text NOT NULL,
  blocks         jsonb NOT NULL DEFAULT '[]'::jsonb,
  seo            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         page_status NOT NULL DEFAULT 'draft',
  parent_id      text REFERENCES pages(id) ON DELETE SET NULL,
  collection_id  text,
  record_id      text,
  is_template    boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,
  locale         text NOT NULL DEFAULT 'en',
  published_at   timestamptz,
  scheduled_for  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text REFERENCES users(id),
  archived_at    timestamptz,
  -- One page per path per locale; templates are exempt since they render many.
  CONSTRAINT pages_unique_path UNIQUE (site_id, locale, path)
);
CREATE INDEX pages_site_status_idx ON pages (site_id, status) WHERE archived_at IS NULL;
CREATE INDEX pages_blocks_idx ON pages USING gin (blocks jsonb_path_ops);

CREATE TABLE navigations (
  id       text PRIMARY KEY,
  org_id   text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id  text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slot     text NOT NULL,
  items    jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT navigations_unique_slot UNIQUE (site_id, slot)
);

-- User-defined CMS collections ("Vehicles", "Properties", "Menu Items").
CREATE TABLE collections (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id      text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  key          text NOT NULL,
  name         text NOT NULL,
  singular     text NOT NULL,
  fields       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Populated when records generate their own pages.
  detail_path_pattern text,
  is_system    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collections_unique_key UNIQUE (site_id, key)
);

CREATE TABLE records (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id        text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  collection_id  text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  slug           text NOT NULL,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         page_status NOT NULL DEFAULT 'draft',
  locale         text NOT NULL DEFAULT 'en',
  sort_order     integer NOT NULL DEFAULT 0,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  CONSTRAINT records_unique_slug UNIQUE (collection_id, locale, slug)
);
CREATE INDEX records_collection_idx ON records (collection_id, status) WHERE archived_at IS NULL;
CREATE INDEX records_data_idx ON records USING gin (data jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- Business Knowledge Graph
-- ---------------------------------------------------------------------------

CREATE TABLE kg_entities (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id     text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type        text NOT NULL,
  dedupe_key  text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kg_entities_unique_dedupe UNIQUE (site_id, type, dedupe_key)
);
CREATE INDEX kg_entities_type_idx ON kg_entities (site_id, type);

CREATE TYPE approval_state AS ENUM ('pending','approved','rejected','auto_approved','needs_review');

-- One row per field per entity. This is what makes "where did this phone
-- number come from, and who confirmed it?" answerable.
CREATE TABLE kg_facts (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id        text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  entity_id      text NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  field_path     text NOT NULL,
  value          jsonb NOT NULL,
  edited_value   jsonb,
  confidence     real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  approval       approval_state NOT NULL DEFAULT 'pending',
  source_kind    text NOT NULL,
  source_locator text NOT NULL,
  source_fragment text,
  content_hash   text,
  retrieved_at   timestamptz NOT NULL,
  alternatives   jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes          text,
  edited_by      text REFERENCES users(id),
  edited_at      timestamptz,
  CONSTRAINT kg_facts_unique_field UNIQUE (entity_id, field_path)
);
-- Drives the review queue: weakest evidence first.
CREATE INDEX kg_facts_review_idx ON kg_facts (site_id, confidence)
  WHERE approval IN ('pending','needs_review');

CREATE TABLE kg_relationships (
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id     text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  from_id     text NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  to_id       text NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  confidence  real NOT NULL DEFAULT 0.8,
  PRIMARY KEY (from_id, to_id, kind)
);

-- ---------------------------------------------------------------------------
-- Smart Import
-- ---------------------------------------------------------------------------

CREATE TABLE import_attestations (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id            text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  attested_by        text NOT NULL REFERENCES users(id),
  basis              text NOT NULL,
  hosts              text[] NOT NULL,
  note               text,
  ip                 inet,
  statement_version  text NOT NULL,
  attested_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attestation_has_hosts CHECK (cardinality(hosts) > 0)
);

CREATE TYPE import_status AS ENUM (
  'pending','crawling','extracting','ready_for_review','applied','failed','cancelled'
);

CREATE TABLE import_jobs (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  attestation_id  text NOT NULL REFERENCES import_attestations(id),
  status          import_status NOT NULL DEFAULT 'pending',
  seeds           text[] NOT NULL,
  budget          jsonb NOT NULL,
  robots_override boolean NOT NULL DEFAULT false,
  review          jsonb,
  error           jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  created_by      text NOT NULL REFERENCES users(id)
);
CREATE INDEX import_jobs_site_idx ON import_jobs (site_id, started_at DESC);

-- Raw crawl output, retained so a re-run does not need to re-fetch and so the
-- user can see exactly what was read from their site.
CREATE TABLE import_pages (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id     text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  job_id      text NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  url         text NOT NULL,
  depth       integer NOT NULL DEFAULT 0,
  status      text NOT NULL,
  http_status integer,
  message     text,
  extracted   jsonb,
  decision    text NOT NULL DEFAULT 'import',
  CONSTRAINT import_pages_unique_url UNIQUE (job_id, url)
);

-- ---------------------------------------------------------------------------
-- Media
-- ---------------------------------------------------------------------------

CREATE TABLE assets (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id              text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind                 text NOT NULL,
  filename             text NOT NULL,
  storage_key          text NOT NULL,
  mime_type            text NOT NULL,
  size_bytes           bigint NOT NULL,
  width                integer,
  height               integer,
  duration_seconds     real,
  alt_text             text,
  alt_text_generated   boolean NOT NULL DEFAULT false,
  caption              text,
  tags                 text[] NOT NULL DEFAULT '{}',
  focal_point          jsonb,
  subject_box          jsonb,
  rights               jsonb NOT NULL,
  phash                text,
  usage_count          integer NOT NULL DEFAULT 0,
  uploaded_by          text REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz
);
CREATE INDEX assets_site_idx ON assets (site_id) WHERE archived_at IS NULL;
CREATE INDEX assets_phash_idx ON assets (site_id, phash) WHERE phash IS NOT NULL;
CREATE INDEX assets_text_idx ON assets USING gin (
  (coalesce(alt_text,'') || ' ' || coalesce(caption,'') || ' ' || filename) gin_trgm_ops
);

-- ---------------------------------------------------------------------------
-- Change sets and versioning
-- ---------------------------------------------------------------------------

CREATE TYPE changeset_status AS ENUM ('draft','previewed','applied','reverted','discarded');

CREATE TABLE change_sets (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id      text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  origin       text NOT NULL,
  title        text NOT NULL,
  intent       text,
  operations   jsonb NOT NULL,
  inverse      jsonb,
  warnings     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status       changeset_status NOT NULL DEFAULT 'draft',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  applied_at   timestamptz,
  reverted_at  timestamptz
);
CREATE INDEX change_sets_site_idx ON change_sets (site_id, created_at DESC);

-- Point-in-time snapshots. Written on publish and before any bulk change, so
-- "restore the site to Tuesday" is a real operation rather than a promise.
CREATE TABLE site_versions (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id      text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  label        text,
  reason       text NOT NULL,
  snapshot     jsonb NOT NULL,
  change_set_id text REFERENCES change_sets(id),
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_versions_site_idx ON site_versions (site_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Forms, leads, domains, integrations
-- ---------------------------------------------------------------------------

CREATE TABLE forms (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id            text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  key                text NOT NULL,
  name               text NOT NULL,
  fields             jsonb NOT NULL DEFAULT '[]'::jsonb,
  notification_emails text[] NOT NULL DEFAULT '{}',
  spam_protection    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forms_unique_key UNIQUE (site_id, key)
);

-- Submissions hold personal data: they are read-audited, retention-bounded,
-- and never included in a site snapshot.
CREATE TABLE form_submissions (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id       text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  form_id       text NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  data          jsonb NOT NULL,
  source_url    text,
  ip            inet,
  user_agent    text,
  spam_score    real,
  status        text NOT NULL DEFAULT 'new',
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Set from the site's retention policy; a scheduled job purges past it.
  purge_after   timestamptz
);
CREATE INDEX form_submissions_form_idx ON form_submissions (form_id, created_at DESC);
CREATE INDEX form_submissions_purge_idx ON form_submissions (purge_after) WHERE purge_after IS NOT NULL;

CREATE TYPE domain_status AS ENUM (
  'pending_verification','verifying','provisioning_certificate','active','failed','removed'
);

CREATE TABLE domains (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id           text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  hostname          citext UNIQUE NOT NULL,
  status            domain_status NOT NULL DEFAULT 'pending_verification',
  verification_token text NOT NULL,
  is_primary        boolean NOT NULL DEFAULT false,
  certificate_expires_at timestamptz,
  last_checked_at   timestamptz,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- Exactly one primary domain per site.
CREATE UNIQUE INDEX domains_one_primary_idx ON domains (site_id) WHERE is_primary;

CREATE TABLE redirects (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id     text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  from_path   text NOT NULL,
  to_path     text NOT NULL,
  status_code integer NOT NULL DEFAULT 301 CHECK (status_code IN (301,302,307,308)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT redirects_unique_from UNIQUE (site_id, from_path)
);

CREATE TABLE integrations (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id        text REFERENCES sites(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  status         text NOT NULL DEFAULT 'connected',
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Credentials live in the secrets manager; this is only a reference.
  secret_ref     text,
  scopes         text[] NOT NULL DEFAULT '{}',
  connected_by   text REFERENCES users(id),
  connected_at   timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  last_error     text
);

CREATE TABLE webhooks (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id      text REFERENCES sites(id) ON DELETE CASCADE,
  url          text NOT NULL,
  events       text[] NOT NULL,
  secret_ref   text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- AI usage and audit
-- ---------------------------------------------------------------------------

CREATE TABLE ai_usage (
  id           bigserial PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id      text REFERENCES sites(id) ON DELETE CASCADE,
  user_id      text REFERENCES users(id),
  request_id   text NOT NULL,
  provider     text NOT NULL,
  model        text NOT NULL,
  capability   text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  images       integer,
  seconds      real,
  credits      integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_org_month_idx ON ai_usage (org_id, created_at DESC);

-- Append-only. Enforced by the revoked UPDATE/DELETE grants in rls.sql.
CREATE TABLE audit_events (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id       text REFERENCES sites(id) ON DELETE CASCADE,
  actor_id      text NOT NULL,
  on_behalf_of  text,
  category      text NOT NULL,
  action        text NOT NULL,
  outcome       text NOT NULL,
  permission    text,
  target_type   text,
  target_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip            inet,
  user_agent    text,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_at_idx ON audit_events (org_id, at DESC);
CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id, at DESC);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pages_touch BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER records_touch BEFORE UPDATE ON records
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER kg_entities_touch BEFORE UPDATE ON kg_entities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A child row must never point at a different tenant than its parent. Foreign
-- keys alone cannot express this, and it is the failure mode that turns a bug
-- into a cross-tenant data leak.
-- SECURITY DEFINER matters here. The lookup below must see the parent row even
-- when RLS would hide it from the calling role; as a plain SECURITY INVOKER
-- function it returned NULL for any site outside the caller's tenant, so a
-- cross-tenant insert was rejected with a misleading "does not match ... NULL"
-- rather than by the RLS policy that should own that decision. Owning the two
-- concerns separately keeps the error the user sees accurate: this trigger
-- reports genuine org/site mismatches, RLS reports tenancy violations.
--
-- search_path is pinned because a SECURITY DEFINER function that resolves
-- unqualified names through the caller's search_path is a privilege-escalation
-- hole.
CREATE OR REPLACE FUNCTION assert_site_org_match() RETURNS trigger AS $$
DECLARE
  parent_org text;
BEGIN
  SELECT org_id INTO parent_org FROM public.sites WHERE id = NEW.site_id;
  IF parent_org IS NULL THEN
    RAISE EXCEPTION 'site % does not exist', NEW.site_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'org_id % does not own site % (owned by %)',
      NEW.org_id, NEW.site_id, parent_org
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE TRIGGER pages_org_match BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION assert_site_org_match();
CREATE TRIGGER assets_org_match BEFORE INSERT OR UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION assert_site_org_match();
CREATE TRIGGER records_org_match BEFORE INSERT OR UPDATE ON records
  FOR EACH ROW EXECUTE FUNCTION assert_site_org_match();
CREATE TRIGGER kg_entities_org_match BEFORE INSERT OR UPDATE ON kg_entities
  FOR EACH ROW EXECUTE FUNCTION assert_site_org_match();
CREATE TRIGGER kg_facts_org_match BEFORE INSERT OR UPDATE ON kg_facts
  FOR EACH ROW EXECUTE FUNCTION assert_site_org_match();
CREATE TRIGGER form_submissions_org_match BEFORE INSERT OR UPDATE ON form_submissions
  FOR EACH ROW EXECUTE FUNCTION assert_site_org_match();
