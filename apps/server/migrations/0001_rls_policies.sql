-- Row-level security (L7, phase 2.3).
--
-- Tenancy is enforced by the database, not by remembering to write a WHERE
-- clause. Every query issued by the application is filtered by a policy that
-- reads a transaction-local session variable set from the verified token.
--
-- Hand-written rather than generated. This file is the tenancy boundary; it is
-- read by anyone self-hosting, and it should be reviewable line by line.
--
-- ---------------------------------------------------------------------------
-- WHY `tenant_keys` IS NOT HERE
--
-- Policies read `gnomon.tenant_id`, which is only known AFTER a token has been
-- verified -- which requires looking up the signing key by `kid` first
-- (ADR-0009). A tenant-scoped policy on `tenant_keys` would gate the very
-- lookup that establishes the tenant, and no request could ever authenticate.
-- The table holds public keys and a kid-to-tenant mapping; a dump of it mints
-- nothing.
--
-- ---------------------------------------------------------------------------
-- WHY `FORCE`, AND WHY THE APP ROLE MUST NOT OWN THESE TABLES
--
-- `ENABLE ROW LEVEL SECURITY` alone does not apply to the table OWNER. The
-- role that runs migrations is usually the owner, so an application that
-- connects with that same role has RLS silently switched off -- which is the
-- most common way to deploy this pattern and believe it is working.
-- `FORCE ROW LEVEL SECURITY` closes that. A SUPERUSER still bypasses
-- everything regardless, so the application must never connect as one.
--
-- See scripts/create-app-role.sql for the role this expects.

-- `USING` filters what a query can SEE.
-- `WITH CHECK` filters what a query can WRITE -- without it, a tenant could
-- INSERT or UPDATE a row into another tenant, which reads as a data-integrity
-- bug long before anyone recognises it as a tenancy breach.
--
-- `current_setting(..., true)` returns NULL when the variable is unset rather
-- than raising. NULL = tenant_id is NULL, never true, so a connection with no
-- tenant context sees NOTHING. The policy fails closed, which is the only
-- acceptable default for a boundary like this.

ALTER TABLE "calendars" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendars" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "calendars_tenant_isolation" ON "calendars"
  USING ("tenant_id" = current_setting('gnomon.tenant_id', true))
  WITH CHECK ("tenant_id" = current_setting('gnomon.tenant_id', true));--> statement-breakpoint

ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "events_tenant_isolation" ON "events"
  USING ("tenant_id" = current_setting('gnomon.tenant_id', true))
  WITH CHECK ("tenant_id" = current_setting('gnomon.tenant_id', true));--> statement-breakpoint

ALTER TABLE "recurrence_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurrence_overrides" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "recurrence_overrides_tenant_isolation" ON "recurrence_overrides"
  USING ("tenant_id" = current_setting('gnomon.tenant_id', true))
  WITH CHECK ("tenant_id" = current_setting('gnomon.tenant_id', true));--> statement-breakpoint

ALTER TABLE "feed_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feed_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "feed_tokens_tenant_isolation" ON "feed_tokens"
  USING ("tenant_id" = current_setting('gnomon.tenant_id', true))
  WITH CHECK ("tenant_id" = current_setting('gnomon.tenant_id', true));--> statement-breakpoint

ALTER TABLE "ics_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ics_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ics_sources_tenant_isolation" ON "ics_sources"
  USING ("tenant_id" = current_setting('gnomon.tenant_id', true))
  WITH CHECK ("tenant_id" = current_setting('gnomon.tenant_id', true));--> statement-breakpoint

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_log_tenant_isolation" ON "audit_log"
  USING ("tenant_id" = current_setting('gnomon.tenant_id', true))
  WITH CHECK ("tenant_id" = current_setting('gnomon.tenant_id', true));
