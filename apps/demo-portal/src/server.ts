import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { SignJWT, importPKCS8 } from 'jose';
import { Pool } from 'pg';
import {
  crowdedPage,
  farTimezonePage,
  hostileCssPage,
  iframePage,
  plainPage,
  strictCspHeader,
  strictCspPage,
  twoEmbedsPage,
} from './pages.js';

/**
 * The reference host integration (phase 4.8).
 *
 * This is what an integrator's portal looks like: it authenticates its own
 * users, mints Gnomon tokens with its own private key, and pastes one script
 * tag. Gnomon has no idea who these users are and never will (ADR-0004).
 *
 * It doubles as the hostile-host test target, which is why it serves the same
 * embed under a range of deliberately awkward conditions.
 */

const PORT = Number(process.env.PORT ?? 4000);
const GNOMON_ORIGIN = process.env.GNOMON_ORIGIN ?? 'http://127.0.0.1:3000';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://gnomon:gnomon@localhost:5433/gnomon';
const KEY_PATH = process.env.DEMO_KEY ?? '../server/.demo-key.pem';
const TENANT = 'demo';
const KID = 'demo-portal';

/**
 * Token lifetime.
 *
 * Deliberately configurable so the suite can mint a nearly-expired token and
 * watch the embed refresh without the user noticing. Five minutes is the
 * documented default; Gnomon refuses anything over fifteen.
 */
const TTL_SECONDS = Number(process.env.DEMO_TOKEN_TTL ?? 300);

/** Lets the suite simulate the host's own token endpoint falling over. */
let tokenEndpointBroken = false;

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
const privateKey = await importPKCS8(readFileSync(KEY_PATH, 'utf8'), 'EdDSA');

const calendars = (
  await pool.query<{ id: string }>(
    `SELECT id FROM calendars WHERE tenant_id = $1 ORDER BY name`,
    [TENANT],
  )
).rows.map((row) => row.id);

if (calendars.length === 0) {
  throw new Error('No demo calendars found. Run the Gnomon seed first.');
}

const calendarIds = calendars.join(',');
const app = new Hono();

/**
 * The one piece of backend an integrator must write.
 *
 * In a real portal the user is identified from the session; here every
 * visitor is the same resident. What matters is the SHAPE: the host decides
 * who this is and which calendars they may see, and Gnomon inherits that
 * decision without ever learning a name.
 */
app.get('/api/gnomon-token', async (c) => {
  if (tokenEndpointBroken) return c.json({ error: 'upstream_unavailable' }, 503);

  const token = await new SignJWT({
    tid: TENANT,
    sub: 'resident-42',
    cal: calendars,
    scp: ['events:read'],
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID })
    .setAudience('gnomon')
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(privateKey);

  // No-store: a token in a shared cache would be handed to the next user.
  return c.json({ token }, 200, { 'Cache-Control': 'no-store' });
});

/** Test controls. Present only because this app IS the test fixture. */
app.post('/api/test/break-token-endpoint', (c) => {
  tokenEndpointBroken = true;
  return c.json({ broken: true });
});
app.post('/api/test/fix-token-endpoint', (c) => {
  tokenEndpointBroken = false;
  return c.json({ broken: false });
});

const options = { gnomonOrigin: GNOMON_ORIGIN, calendars: calendarIds };

app.get('/', (c) => c.html(plainPage(options)));
app.get('/hostile-css', (c) => c.html(hostileCssPage(options)));
app.get('/crowded', (c) => c.html(crowdedPage(options)));
app.get('/two-embeds', (c) => c.html(twoEmbedsPage(options)));
app.get('/far-timezone', (c) => c.html(farTimezonePage(options)));
app.get('/iframe', (c) => c.html(iframePage(options)));

app.get('/strict-csp', (c) =>
  c.html(strictCspPage(options), 200, {
    'Content-Security-Policy': strictCspHeader(GNOMON_ORIGIN),
  }),
);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`demo-portal listening on http://127.0.0.1:${info.port}`);
  console.log(`  gnomon: ${GNOMON_ORIGIN}`);
  console.log(`  calendars: ${calendarIds}`);
});
