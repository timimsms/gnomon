CREATE TYPE "public"."audit_operation" AS ENUM('create', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('confirmed', 'tentative', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."timing_kind" AS ENUM('timed', 'allDay');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"subject" text NOT NULL,
	"calendar_id" uuid,
	"event_id" uuid,
	"operation" "audit_operation" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"time_zone" text NOT NULL,
	"colour" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendars_id_tenant_key" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"calendar_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"status" "event_status",
	"timing_kind" "timing_kind" NOT NULL,
	"start_local" timestamp,
	"end_local" timestamp,
	"time_zone" text,
	"start_date" date,
	"end_date" date,
	"recurrence" text,
	"exception_dates" text[],
	"sequence" integer,
	"search_span" "tstzrange" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_id_tenant_key" UNIQUE("id","tenant_id"),
	CONSTRAINT "events_timed_shape" CHECK ("events"."timing_kind" <> 'timed' OR (
            "events"."start_local" IS NOT NULL AND "events"."end_local" IS NOT NULL
            AND "events"."time_zone" IS NOT NULL
            AND "events"."start_date" IS NULL AND "events"."end_date" IS NULL)),
	CONSTRAINT "events_all_day_shape" CHECK ("events"."timing_kind" <> 'allDay' OR (
            "events"."start_date" IS NOT NULL AND "events"."end_date" IS NOT NULL
            AND "events"."start_local" IS NULL AND "events"."end_local" IS NULL
            AND "events"."time_zone" IS NULL)),
	CONSTRAINT "events_timed_order" CHECK ("events"."end_local" IS NULL OR "events"."end_local" >= "events"."start_local"),
	CONSTRAINT "events_all_day_order" CHECK ("events"."end_date" IS NULL OR "events"."end_date" > "events"."start_date")
);
--> statement-breakpoint
CREATE TABLE "feed_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"calendar_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ics_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"calendar_id" uuid NOT NULL,
	"url" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurrence_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"recurrence_id" text NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"patch" jsonb,
	"sequence" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurrence_overrides_cancelled_has_no_patch" CHECK (NOT "recurrence_overrides"."cancelled" OR "recurrence_overrides"."patch" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "tenant_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"public_key_spki" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_calendar_tenant_fk" FOREIGN KEY ("calendar_id","tenant_id") REFERENCES "public"."calendars"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_tokens" ADD CONSTRAINT "feed_tokens_calendar_tenant_fk" FOREIGN KEY ("calendar_id","tenant_id") REFERENCES "public"."calendars"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ics_sources" ADD CONSTRAINT "ics_sources_calendar_tenant_fk" FOREIGN KEY ("calendar_id","tenant_id") REFERENCES "public"."calendars"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_overrides" ADD CONSTRAINT "recurrence_overrides_event_tenant_fk" FOREIGN KEY ("event_id","tenant_id") REFERENCES "public"."events"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_keys" ADD CONSTRAINT "tenant_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_at_idx" ON "audit_log" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "calendars_tenant_idx" ON "calendars" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "events_tenant_calendar_idx" ON "events" USING btree ("tenant_id","calendar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_calendar_uid_key" ON "events" USING btree ("calendar_id","uid");--> statement-breakpoint
CREATE INDEX "events_search_span_idx" ON "events" USING gist ("search_span");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_tokens_hash_key" ON "feed_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "feed_tokens_tenant_calendar_idx" ON "feed_tokens" USING btree ("tenant_id","calendar_id");--> statement-breakpoint
CREATE INDEX "ics_sources_tenant_calendar_idx" ON "ics_sources" USING btree ("tenant_id","calendar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurrence_overrides_event_instance_key" ON "recurrence_overrides" USING btree ("event_id","recurrence_id");--> statement-breakpoint
CREATE INDEX "recurrence_overrides_tenant_idx" ON "recurrence_overrides" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_keys_tenant_idx" ON "tenant_keys" USING btree ("tenant_id");