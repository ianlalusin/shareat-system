/**
 * drizzle-kit config — serves `npm run db:studio` ONLY.
 *
 * `npm run db:generate` is RETIRED and fails closed (generate-retired.ts): migrations here are
 * hand-authored — docs/decisions/ADR-012-hand-authored-migrations.md, DEF-242. `db:migrate` does
 * not read this file either; it is migrate.ts on drizzle-orm's own migrator.
 */
import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

config({ path: '../../.env.local' });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
}

export default defineConfig({
  schema: './schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
