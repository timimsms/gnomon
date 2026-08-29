-- Linking events to the ICS source that produced them (phase 7.2).
--
-- Two things depend on this, and neither works without it:
--
--   1. RECONCILIATION SCOPE. A poll computes adds, changes and deletions
--      against the source's own events. Without this column the only way to
--      find "events this feed used to contain" is by calendar -- which would
--      delete events a user created by hand the moment a feed stopped
--      mentioning them.
--
--   2. INGESTED EVENTS ARE READ-ONLY. An edit to a synced event is silently
--      reverted by the next poll, so the write path refuses it outright
--      rather than accepting a change it knows will not survive.
--
-- Nullable, because a hand-created event has no source. That is the common
-- case, and it is what NULL means here.

ALTER TABLE "ics_sources" ADD CONSTRAINT "ics_sources_id_tenant_key" UNIQUE ("id", "tenant_id");--> statement-breakpoint

ALTER TABLE "events" ADD COLUMN "ics_source_id" uuid;--> statement-breakpoint

-- Composite, like every other foreign key here: the tenant is part of the
-- key, so an event cannot point at another tenant's source even if RLS were
-- somehow bypassed.
ALTER TABLE "events" ADD CONSTRAINT "events_ics_source_tenant_fk"
  FOREIGN KEY ("ics_source_id", "tenant_id")
  REFERENCES "ics_sources"("id", "tenant_id") ON DELETE CASCADE;--> statement-breakpoint

-- A digest of everything we store about an event, so a poll can answer "did
-- this change?" with one comparison rather than a deep equality that has to
-- be kept in step with the schema. NULL for hand-created events, which are
-- never reconciled.
ALTER TABLE "events" ADD COLUMN "fingerprint" text;--> statement-breakpoint

-- The reconciler's hot path: "every event this source produced".
CREATE INDEX "events_ics_source_idx" ON "events" ("ics_source_id") WHERE "ics_source_id" IS NOT NULL;--> statement-breakpoint

COMMENT ON COLUMN "events"."ics_source_id" IS
  'The ICS source that produced this event, or NULL if it was created directly. Ingested events are read-only to the write path; see migration 0004.';
