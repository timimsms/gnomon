import { writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { mintFeedToken } from './feeds/tokens.js';
import { Pool } from 'pg';
import { toEventRow } from './db/events.js';
import type { CalendarEvent, CalendarId, EventId, TenantId } from '@gnomon/core';

/**
 * Seeds a demo tenant (phase 3.5).
 *
 * The events are chosen to be the ones worth LOOKING at rather than the ones
 * easiest to write: a weekly meeting that crosses the US spring-forward, and
 * a floating all-day holiday. Between them they exercise the two decisions
 * that were hardest to make (ADR-0005) and the defect class that took the
 * longest to find, so a demo that renders them correctly is showing something.
 */

const DEMO_TENANT = 'demo' as TenantId;
const KID = 'demo-portal';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://gnomon:gnomon@localhost:5433/gnomon';
const keyOut = process.env.DEMO_KEY_OUT ?? '.demo-key.pem';

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

async function main() {
  // A fresh key pair each seed rather than one committed to the repository.
  // A checked-in private key is a private key someone eventually copies into
  // production, and the demo is exactly where that habit would start.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeySpki = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeFileSync(keyOut, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), {
    mode: 0o600,
  });

  let maintenance = '';
  let holidays = '';
  let feedToken = '';

  await pool.query('BEGIN');
  try {
    await pool.query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'Demo Portal')
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [DEMO_TENANT],
    );

    await pool.query(
      `INSERT INTO tenant_keys (kid, tenant_id, public_key_spki) VALUES ($1, $2, $3)
         ON CONFLICT (kid) DO UPDATE
           SET public_key_spki = EXCLUDED.public_key_spki, retired_at = NULL`,
      [KID, DEMO_TENANT, publicKeySpki],
    );

    maintenance = await upsertCalendar('Building maintenance', 'America/New_York');
    holidays = await upsertCalendar('Public holidays', 'America/New_York');

    await pool.query('DELETE FROM events WHERE tenant_id = $1', [DEMO_TENANT]);

    await insertEvent({
      calendarId: maintenance,
      uid: 'boiler-inspection@demo',
      title: 'Boiler inspection',
      location: 'Basement',
      // Starts a week before the 2026 US spring-forward, so the third
      // occurrence lands the morning the clocks move. It must still read
      // 09:00 -- which is the thing three of the four upstream defects got
      // wrong, and the reason the conformance corpus exists.
      timing: {
        kind: 'timed',
        start: '2026-03-01T09:00:00',
        end: '2026-03-01T10:00:00',
        timeZone: 'America/New_York',
      },
      recurrence: 'FREQ=WEEKLY;COUNT=8',
    });

    await insertEvent({
      calendarId: maintenance,
      uid: 'fire-alarm-test@demo',
      title: 'Fire alarm test',
      timing: {
        kind: 'timed',
        start: '2026-03-05T14:00:00',
        end: '2026-03-05T14:30:00',
        timeZone: 'America/New_York',
      },
    });

    await insertEvent({
      calendarId: holidays,
      uid: 'independence-day@demo',
      title: 'Independence Day',
      // Floating: 4 July is 4 July wherever you are reading from (ADR-0005).
      // endDate is exclusive.
      timing: { kind: 'allDay', startDate: '2026-07-04', endDate: '2026-07-05' },
    });

    // A subscribable feed for the maintenance calendar, so the demo can be
    // added to a real calendar client without any further setup.
    await pool.query('DELETE FROM feed_tokens WHERE tenant_id = $1', [DEMO_TENANT]);
    const feed = mintFeedToken();
    await pool.query(
      `INSERT INTO feed_tokens (tenant_id, calendar_id, token_hash, label)
       VALUES ($1, $2, $3, 'demo subscription')`,
      [DEMO_TENANT, maintenance, feed.hash],
    );
    feedToken = feed.token;

    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }

  console.log(`Seeded tenant "${DEMO_TENANT}".`);
  console.log(`Private key written to ${keyOut} (mode 0600, gitignored).`);
  console.log('');
  // Real ids, so the printed commands are copy-pasteable rather than a
  // template the reader has to fill in. This block is the quickstart.
  console.log('Mint a token and call the API:');
  console.log('');
  console.log('  TOKEN=$(node examples/token-minting/node/mint.mjs \\');
  console.log(`    --key apps/server/${keyOut} --kid ${KID} --tenant ${DEMO_TENANT} \\`);
  console.log(`    --subject resident-42 --calendars ${maintenance},${holidays})`);
  console.log('');
  console.log('  curl -s -H "Authorization: Bearer $TOKEN" \\');
  console.log(
    `    'http://localhost:3000/events?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z&tz=America/New_York'`,
  );
  console.log('');
  console.log('Subscribe from a calendar client (the token is shown once):');
  console.log('');
  console.log(`  webcal://localhost:3000/feeds/${feedToken}.ics`);
}

async function upsertCalendar(name: string, timeZone: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO calendars (tenant_id, name, time_zone) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id`,
    [DEMO_TENANT, name, timeZone],
  );
  if (rows[0]) return rows[0].id;

  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM calendars WHERE tenant_id = $1 AND name = $2`,
    [DEMO_TENANT, name],
  );
  return existing.rows[0]!.id;
}

async function insertEvent(
  input: Omit<CalendarEvent, 'id' | 'tenantId' | 'calendarId'> & { calendarId: string },
) {
  // Routed through toEventRow so the demo data gets the same conservative
  // search_span as anything else. Hand-writing the range here would be the
  // one row in the database that the phase 2 invariant never covered.
  const row = toEventRow({
    ...input,
    id: '00000000-0000-4000-8000-000000000000' as EventId,
    tenantId: DEMO_TENANT,
    calendarId: input.calendarId as CalendarId,
  });

  await pool.query(
    `INSERT INTO events (tenant_id, calendar_id, uid, title, description, location, status,
       timing_kind, start_local, end_local, time_zone, start_date, end_date,
       recurrence, exception_dates, sequence, search_span)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      row.tenantId, row.calendarId, row.uid, row.title, row.description, row.location, row.status,
      row.timingKind, row.startLocal, row.endLocal, row.timeZone, row.startDate, row.endDate,
      row.recurrence, row.exceptionDates, row.sequence, row.searchSpan,
    ],
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
