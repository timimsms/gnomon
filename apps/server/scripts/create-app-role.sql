-- The role the application connects as.
--
-- Run this ONCE per deployment, as a superuser, AFTER migrations. It is
-- deliberately not a migration: the role name and password are deployment
-- configuration, not schema, and a migration that invents credentials is a
-- migration nobody can review.
--
-- ---------------------------------------------------------------------------
-- THIS FILE IS THE DIFFERENCE BETWEEN RLS WORKING AND RLS BEING DECORATIVE.
--
-- Row-level security is bypassed entirely by:
--   * a SUPERUSER, always, regardless of FORCE
--   * the table OWNER, unless FORCE ROW LEVEL SECURITY is set
--
-- The role below is neither. It owns nothing and inherits nothing. If you
-- point the application at your migration role, or at `postgres`, every
-- policy in 0001_rls_policies.sql becomes a comment and every tenant can read
-- every other tenant -- with no error, no warning, and no failing test.
--
-- Set the password from your secret store; the placeholder is not a default.

CREATE ROLE gnomon_app LOGIN PASSWORD 'CHANGE_ME';

-- No CREATE on the schema: the application never migrates itself.
GRANT USAGE ON SCHEMA public TO gnomon_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  calendars, events, recurrence_overrides, feed_tokens, ics_sources
  TO gnomon_app;

-- tenant_keys is read-only to the application. Registering and retiring keys
-- is an operator action, and the application has no reason to write here.
-- (This table is not RLS-covered -- see 0001_rls_policies.sql for why.)
GRANT SELECT ON tenant_keys TO gnomon_app;

GRANT SELECT ON tenants TO gnomon_app;

-- Append-only in practice, not merely in intent (phase 6.3). Without UPDATE
-- or DELETE granted, a compromised application cannot rewrite its own history
-- no matter what the code says.
GRANT SELECT, INSERT ON audit_log TO gnomon_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gnomon_app;

-- Verify, rather than assume:
--
--   SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'gnomon_app';
--     -> both must be false
--
--   SELECT relname, relrowsecurity, relforcerowsecurity
--     FROM pg_class WHERE relname = 'events';
--     -> both must be true
