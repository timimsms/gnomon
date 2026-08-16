import { defineConfig } from 'drizzle-kit';

/**
 * `drizzle-kit generate` produces migration SQL from the schema WITHOUT a
 * database connection, so migrations can be written and reviewed offline.
 * Only applying them needs Postgres (phase 2.3, 2.6).
 *
 * Migration files are checked in and reviewed as public API -- self-hosters
 * and integrators read this schema.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://gnomon:gnomon@localhost:5433/gnomon',
  },
});
