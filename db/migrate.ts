/**
 * Migration runner. Forward-only, committed, never edited after being applied anywhere.
 * PROJECT_BIBLE.md §15.5 (expand/contract) and §2 rule 8.
 */
import { existsSync } from 'node:fs';
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

config({ path: '.env.local' });

const MIGRATIONS_DIR = './db/migrations';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.');
  }

  const redacted = url.replace(/:\/\/[^@]*@/, '://***:***@');

  // Drizzle needs a generated journal. Before the first `npm run db:generate` there is
  // nothing to apply. That is a legitimate empty state, not a failure — but say so
  // explicitly rather than exiting quietly, so an EMPTY run can never be mistaken for a
  // SUCCESSFUL one (PROJECT_BIBLE.md §15.6).
  if (!existsSync(`${MIGRATIONS_DIR}/meta/_journal.json`)) {
    console.warn(
      `No migrations found in ${MIGRATIONS_DIR}. Nothing to apply.\n` +
        'Run "npm run db:generate" once db/schema/ defines tables.',
    );
    return;
  }

  console.log(`Applying migrations to ${redacted}`);
  const sql = postgres(url, { max: 1 });
  const start = Date.now();

  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
    console.log(`Migrations applied in ${Date.now() - start}ms`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('Migration FAILED:', error);
  process.exit(1);
});
