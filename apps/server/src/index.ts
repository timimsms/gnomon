import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createDatabase } from './db/client.js';
import { createApp } from './http/app.js';
import { PostgresKeyRegistry } from './registry/postgres.js';

/**
 * Server entrypoint.
 *
 * `docker compose up` must produce a working calendar in under two minutes or
 * the OSS adoption story fails at the first step, so this deliberately has no
 * required configuration beyond a database URL.
 */

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://gnomon:gnomon@localhost:5433/gnomon';
const port = Number(process.env.PORT ?? 3000);

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = createApp({
  db: createDatabase(databaseUrl),
  registry: new PostgresKeyRegistry(pool),
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Gnomon listening on http://localhost:${info.port}`);
  console.log(`OpenAPI: http://localhost:${info.port}/openapi.json`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}
