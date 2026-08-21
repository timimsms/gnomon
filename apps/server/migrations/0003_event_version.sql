-- Optimistic concurrency for the write path (phase 6.4).
--
-- Two portal tabs editing one event must not silently lose a write, and
-- "last write wins" IS a silent loss -- the user who lost has no way to know.
--
-- ---------------------------------------------------------------------------
-- WHY A COLUMN RATHER THAN `updated_at`
--
-- `updated_at` defaults to now(), which inside a transaction is the
-- TRANSACTION START time, not the statement time. Two concurrent updates that
-- began in the same instant would carry identical timestamps, and an
-- If-Match built on that would let one overwrite the other while both
-- believed they held the current version. A monotonic counter has no such
-- tie, and it reads unambiguously in a migration that integrators review.
--
-- `xmin` was the other candidate -- Postgres' own per-row transaction id,
-- free and requiring no schema change. Rejected because it wraps around, is
-- not portable, and would put a system column in our public API.

ALTER TABLE "events" ADD COLUMN "version" integer NOT NULL DEFAULT 1;--> statement-breakpoint

COMMENT ON COLUMN "events"."version" IS
  'Incremented on every update. Used for If-Match optimistic concurrency; see migration 0003.';
