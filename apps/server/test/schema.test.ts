import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { TENANT_SCOPED_TABLES, events, tenants } from '../src/db/schema.js';

/**
 * Schema invariants, checked without a database.
 *
 * Applying a migration needs Postgres (phase 2.3, 2.6). Everything here is
 * about the schema being SHAPED correctly, which is checkable offline and is
 * where the tenancy guarantees are actually decided.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

const migrationSql = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith('.sql'))
  .map((file) => readFileSync(join(MIGRATIONS, file), 'utf8'))
  .join('\n');

describe('every tenant-scoped table carries tenant_id', () => {
  it('lists a non-trivial set of tables', () => {
    // Guards against the whole suite passing vacuously if the export moves.
    expect(TENANT_SCOPED_TABLES.length).toBeGreaterThanOrEqual(7);
  });

  for (const table of TENANT_SCOPED_TABLES) {
    it(`${getTableName(table)} has a non-null tenant_id`, () => {
      // L7: tenancy is enforced by the database, and an RLS policy needs a
      // column to read. A table added without this is one RLS silently does
      // not cover.
      const tenantId = getTableColumns(table).tenantId;
      expect(tenantId, `${getTableName(table)} has no tenantId column`).toBeDefined();
      expect(tenantId?.notNull).toBe(true);
    });
  }

  it('does not claim tenants itself is tenant-scoped', () => {
    // `tenants` is the root of the hierarchy; giving it a tenant_id would be
    // a self-reference that means nothing.
    const names = TENANT_SCOPED_TABLES.map(getTableName);
    expect(names).not.toContain(getTableName(tenants));
  });
});

describe('the generated migration contains the constraints the schema claims', () => {
  /**
   * This suite exists because of a real near-miss. The composite foreign keys
   * were originally written as raw `sql` template literals inside the table
   * extras array, which Drizzle accepts and SILENTLY IGNORES -- it emitted
   * "events ... 0 fks" and produced a migration with no foreign key on
   * events at all. Typecheck passed. Nothing else would have caught it until
   * cross-tenant rows appeared in production.
   *
   * Asserting on the emitted SQL is the only place that mismatch is visible.
   */

  it('found migration SQL to assert against', () => {
    expect(migrationSql.length).toBeGreaterThan(500);
    expect(migrationSql).toContain('CREATE TABLE "events"');
  });

  for (const [table, columns] of [
    ['events', '"calendar_id","tenant_id"'],
    ['feed_tokens', '"calendar_id","tenant_id"'],
    ['ics_sources', '"calendar_id","tenant_id"'],
    ['recurrence_overrides', '"event_id","tenant_id"'],
  ] as const) {
    it(`${table} references its parent by a COMPOSITE key including tenant_id`, () => {
      // The tenant column being part of the key is what makes a cross-tenant
      // reference impossible at the storage layer, rather than merely
      // discouraged by a policy someone might misconfigure.
      const pattern = new RegExp(
        `ALTER TABLE "${table}" ADD CONSTRAINT "[^"]+" FOREIGN KEY \\(${columns.replace(/[()]/g, '\\$&')}\\)`,
      );
      expect(migrationSql).toMatch(pattern);
    });
  }

  it('enforces the timing union with CHECK constraints', () => {
    // Without these, `timing_kind = 'allDay'` alongside a populated
    // start_local is a representable state with no meaning (ADR-0005).
    expect(migrationSql).toContain('CONSTRAINT "events_timed_shape" CHECK');
    expect(migrationSql).toContain('CONSTRAINT "events_all_day_shape" CHECK');
    expect(migrationSql).toContain('CONSTRAINT "events_timed_order" CHECK');
    expect(migrationSql).toContain('CONSTRAINT "events_all_day_order" CHECK');
  });

  it('indexes the search span with GiST', () => {
    // A btree index on a range type would not answer overlap queries, so the
    // access method is part of the requirement rather than an optimisation.
    expect(migrationSql).toMatch(/CREATE INDEX "events_search_span_idx" ON "events" USING gist/);
  });

  it('keeps an event uid unique per calendar rather than globally', () => {
    // Global uniqueness would make ingesting one ICS feed into two calendars
    // collide (phase 7.2).
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX "events_calendar_uid_key" ON "events" USING btree \("calendar_id","uid"\)/,
    );
  });

  it('declares tenant_id NOT NULL on every tenant-scoped table', () => {
    for (const table of TENANT_SCOPED_TABLES) {
      const name = getTableName(table);
      const block = new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`).exec(migrationSql);
      expect(block, `no CREATE TABLE found for ${name}`).not.toBeNull();
      expect(block?.[1], `${name}.tenant_id is nullable`).toMatch(/"tenant_id" text NOT NULL/);
    }
  });

  it('stores feed tokens hashed and uniquely', () => {
    // A calendar client pastes a feed URL once and polls it for years, so a
    // database read must not yield working URLs (phase 5.1).
    expect(migrationSql).toContain('"token_hash" text NOT NULL');
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX "feed_tokens_hash_key"/);
    expect(migrationSql).not.toMatch(/"feed_tokens"[\s\S]*?"token" text/);
  });

  it('gives tenant_keys a globally unique kid', () => {
    // Lookup happens by kid alone, before any tenant is known (ADR-0009).
    // Scoping it per tenant would make that lookup ambiguous.
    expect(migrationSql).toMatch(/CREATE TABLE "tenant_keys" \(\s*\n\s*"kid" text PRIMARY KEY/);
  });

  it('never stores a private key column', () => {
    // ADR-0009's whole premise: a dump of our database mints nothing.
    expect(migrationSql).not.toMatch(/private_key|secret|hmac/i);
  });
});

describe('the events table encodes ADR-0005 rather than a boolean flag', () => {
  it('has no all_day boolean', () => {
    const columns = Object.keys(getTableColumns(events));
    expect(columns).not.toContain('allDay');
    expect(columns).toContain('timingKind');
  });

  it('keeps floating dates in date columns and wall-clock times in timestamps without a zone', () => {
    const columns = getTableColumns(events);
    // A `timestamptz` here would resolve the floating date at write time,
    // which is precisely the zone-anchored model ADR-0005 rejected.
    expect(columns.startDate?.getSQLType()).toBe('date');
    expect(columns.endDate?.getSQLType()).toBe('date');
    expect(columns.startLocal?.getSQLType()).toBe('timestamp');
    expect(columns.searchSpan?.getSQLType()).toBe('tstzrange');
  });
});
