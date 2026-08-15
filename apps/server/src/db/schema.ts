import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Gnomon's schema.
 *
 * Migration files are reviewed as public API: the schema is visible to
 * integrators and to anyone self-hosting, so readability is a requirement
 * rather than a nicety.
 *
 * Two conventions run through everything here:
 *
 *   1. Every tenant-scoped table carries a non-null `tenant_id` (L7). RLS
 *      policies attach to these in phase 2.3; `test/schema.test.ts` fails if
 *      a new table appears without one.
 *
 *   2. Rows never reference across tenants. Foreign keys are COMPOSITE --
 *      (calendar_id, tenant_id) rather than calendar_id alone -- so a
 *      cross-tenant reference is rejected by the database itself, not merely
 *      by a policy someone might misconfigure. Defence that survives RLS
 *      being switched off is worth the extra column in the constraint.
 */

/**
 * `tstzrange` has no Drizzle builtin. We only ever write it from
 * `toEventRow` and read it as an opaque bound, so a string-passthrough type
 * is the whole requirement.
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => 'tstzrange',
});

export const timingKind = pgEnum('timing_kind', ['timed', 'allDay']);
export const eventStatus = pgEnum('event_status', ['confirmed', 'tentative', 'cancelled']);
export const auditOperation = pgEnum('audit_operation', ['create', 'update', 'delete']);

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Registered Ed25519 public keys (ADR-0009).
 *
 * Only public keys live here. A full dump of this table lets an attacker
 * verify tokens, which anyone could already do, and mint nothing -- which is
 * the entire reason we declined a shared-secret scheme.
 *
 * `kid` is the PRIMARY KEY, so it is globally unique rather than unique per
 * tenant. Lookup happens by `kid` alone, before any tenant is known, and the
 * tenant is then derived from the row. Scoping `kid` per tenant would make
 * that lookup ambiguous and reintroduce the "trust the claim" hazard
 * ADR-0009 exists to remove.
 */
export const tenantKeys = pgTable(
  'tenant_keys',
  {
    kid: text('kid').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** SPKI PEM. Never a private key -- registration refuses those. */
    publicKeySpki: text('public_key_spki').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Retirement is the only revocation lever we have, since tokens expire
     * rather than being recalled (ADR-0004). Nullable rather than a hard
     * delete so an incident can be reconstructed afterwards; every lookup
     * MUST filter on it.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [index('tenant_keys_tenant_idx').on(table.tenantId)],
);

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

export const calendars = pgTable(
  'calendars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * Default timezone for timed events on this calendar.
     *
     * Per ADR-0005 this does NOT anchor all-day events -- those are floating
     * dates. Nothing derived from this column may change the meaning of a
     * stored all-day event.
     */
    timeZone: text('time_zone').notNull(),
    colour: text('colour'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('calendars_tenant_idx').on(table.tenantId),
    // Redundant given the primary key, and required as the target of the
    // composite foreign keys below.
    uniqueIndex('calendars_id_tenant_key').on(table.id, table.tenantId),
  ],
);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    calendarId: uuid('calendar_id').notNull(),

    /**
     * RFC 5545 UID. Distinct from `id` on purpose: it must survive an ICS
     * round trip and must not be assumed equal to our primary key. Unique
     * per CALENDAR rather than globally, so ingesting one feed into two
     * calendars does not collide (phase 7.2 reconciles on this).
     */
    uid: text('uid').notNull(),

    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    status: eventStatus('status'),

    /**
     * ADR-0005's discriminated union, flattened into columns. The CHECK
     * constraints below are what keep it a union rather than six nullable
     * fields that can express nonsense.
     */
    timingKind: timingKind('timing_kind').notNull(),

    /** Timed events: wall-clock local time, plus the zone it is local TO. */
    startLocal: timestamp('start_local', { withTimezone: false, mode: 'string' }),
    endLocal: timestamp('end_local', { withTimezone: false, mode: 'string' }),
    timeZone: text('time_zone'),

    /** All-day events: floating dates. `end_date` is EXCLUSIVE. */
    startDate: date('start_date'),
    endDate: date('end_date'),

    /** RFC 5545 RRULE value, without the "RRULE:" prefix. */
    recurrence: text('recurrence'),
    exceptionDates: text('exception_dates').array(),
    sequence: integer('sequence'),

    /**
     * A CONSERVATIVE SUPERSET of every instant this event could occupy.
     *
     * This is a cache, not truth. It exists so a range query can discard
     * events cheaply before the real expansion runs; the exact boundaries are
     * always applied afterwards by `@gnomon/core`. The only invariant that
     * matters is that it is never NARROWER than reality -- a too-wide span
     * costs a wasted expansion, a too-narrow one silently loses events.
     *
     * Written solely by `toEventRow`, which is where the reasoning lives.
     * Notably it does NOT depend on the calendar's timezone, so correcting a
     * misconfigured `calendars.time_zone` cannot invalidate stored spans.
     */
    searchSpan: tstzrange('search_span').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('events_tenant_calendar_idx').on(table.tenantId, table.calendarId),
    uniqueIndex('events_calendar_uid_key').on(table.calendarId, table.uid),

    // GiST over the span is what makes the pre-filter cheap. Phase 3's
    // `GET /events?from&to` is the query this exists for.
    index('events_search_span_idx').using('gist', table.searchSpan),

    // Required as the target of recurrence_overrides' composite key below.
    uniqueIndex('events_id_tenant_key').on(table.id, table.tenantId),

    // Cross-tenant references are impossible at the storage layer, not just
    // discouraged by policy. The tenant column is part of the KEY, so an
    // event can only point at a calendar of its own tenant.
    foreignKey({
      columns: [table.calendarId, table.tenantId],
      foreignColumns: [calendars.id, calendars.tenantId],
      name: 'events_calendar_tenant_fk',
    }).onDelete('cascade'),

    // The union, enforced. Without these, `timing_kind = 'allDay'` alongside
    // a populated `start_local` is a representable state with no meaning, and
    // every reader has to decide what to do about it.
    check(
      'events_timed_shape',
      sql`${table.timingKind} <> 'timed' OR (
            ${table.startLocal} IS NOT NULL AND ${table.endLocal} IS NOT NULL
            AND ${table.timeZone} IS NOT NULL
            AND ${table.startDate} IS NULL AND ${table.endDate} IS NULL)`,
    ),
    check(
      'events_all_day_shape',
      sql`${table.timingKind} <> 'allDay' OR (
            ${table.startDate} IS NOT NULL AND ${table.endDate} IS NOT NULL
            AND ${table.startLocal} IS NULL AND ${table.endLocal} IS NULL
            AND ${table.timeZone} IS NULL)`,
    ),
    // Zero-length timed events are legal (phase 1 has a fixture for one);
    // inverted ones are not.
    check('events_timed_order', sql`${table.endLocal} IS NULL OR ${table.endLocal} >= ${table.startLocal}`),
    // All-day end is exclusive, so a single-day event is start + 1 and the
    // bound is strict.
    check('events_all_day_order', sql`${table.endDate} IS NULL OR ${table.endDate} > ${table.startDate}`),
  ],
);

/**
 * A modification to one instance of a recurring series.
 *
 * `cancelled` is distinct from an EXDATE: an EXDATE removes the instance from
 * the series entirely, while a cancelled instance remains part of it and
 * still round-trips through ICS.
 */
export const recurrenceOverrides = pgTable(
  'recurrence_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    eventId: uuid('event_id').notNull(),

    /** The original rule-produced start this override replaces. */
    recurrenceId: text('recurrence_id').notNull(),

    cancelled: boolean('cancelled').notNull().default(false),
    /** Absent when cancelled. Partial: only the fields that changed. */
    patch: jsonb('patch'),

    /** RFC 5545 SEQUENCE. Higher wins when two overrides collide. */
    sequence: integer('sequence'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('recurrence_overrides_event_instance_key').on(table.eventId, table.recurrenceId),
    index('recurrence_overrides_tenant_idx').on(table.tenantId),
    foreignKey({
      columns: [table.eventId, table.tenantId],
      foreignColumns: [events.id, events.tenantId],
      name: 'recurrence_overrides_event_tenant_fk',
    }).onDelete('cascade'),
    check(
      'recurrence_overrides_cancelled_has_no_patch',
      sql`NOT ${table.cancelled} OR ${table.patch} IS NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Later phases: shape defined here so the first migration is not immediately
// superseded. Behaviour, and any change these need, belongs to their phase.
// ---------------------------------------------------------------------------

/**
 * Phase 5. Opaque, revocable, per-calendar subscription URLs.
 *
 * The token is stored HASHED: a calendar client pastes a feed URL once and
 * polls it for years, so a database read must not yield working URLs. These
 * are NOT the short-lived JWTs of ADR-0004 -- different lifetime, different
 * threat model, deliberately a different table.
 */
export const feedTokens = pgTable(
  'feed_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    calendarId: uuid('calendar_id').notNull(),
    /** SHA-256 of the token. The token itself is shown once, at creation. */
    tokenHash: text('token_hash').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Individually revocable, so one leak does not rotate every subscriber. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('feed_tokens_hash_key').on(table.tokenHash),
    index('feed_tokens_tenant_calendar_idx').on(table.tenantId, table.calendarId),
    foreignKey({
      columns: [table.calendarId, table.tenantId],
      foreignColumns: [calendars.id, calendars.tenantId],
      name: 'feed_tokens_calendar_tenant_fk',
    }).onDelete('cascade'),
  ],
);

/** Phase 7. External ICS feeds polled into a calendar. */
export const icsSources = pgTable(
  'ics_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    calendarId: uuid('calendar_id').notNull(),
    /**
     * Tenant-supplied, and therefore an SSRF sink. Phase 7.2 validates it
     * AFTER DNS resolution -- a hostname that resolves inward defeats any
     * check made before.
     */
    url: text('url').notNull(),
    /** Conditional-fetch state; polling without these is rude and expensive. */
    etag: text('etag'),
    lastModified: text('last_modified'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** Drives backoff, and surfaces a source that has quietly died. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ics_sources_tenant_calendar_idx').on(table.tenantId, table.calendarId),
    foreignKey({
      columns: [table.calendarId, table.tenantId],
      foreignColumns: [calendars.id, calendars.tenantId],
      name: 'ics_sources_calendar_tenant_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Phase 6. Append-only.
 *
 * Append-only in practice, not only in intent: the application role gets no
 * UPDATE or DELETE grant on this table (phase 2.3).
 *
 * `subject` is the opaque `sub` from the token, so this log is only
 * meaningful joined against the host's own records. Integrators need to be
 * told to keep that mapping -- they will want it eventually.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    subject: text('subject').notNull(),
    calendarId: uuid('calendar_id'),
    eventId: uuid('event_id'),
    operation: auditOperation('operation').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_log_tenant_at_idx').on(table.tenantId, table.at)],
);

/** Every table that RLS must cover. `test/schema.test.ts` checks this is complete. */
export const TENANT_SCOPED_TABLES = [
  tenantKeys,
  calendars,
  events,
  recurrenceOverrides,
  feedTokens,
  icsSources,
  auditLog,
] as const;
