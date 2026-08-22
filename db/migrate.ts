/**
 * Migration runner. Forward-only, committed, never edited after being applied anywhere.
 * PROJECT_BIBLE.md §15.5 (expand/contract) and §2 rule 8.
 */
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

config({ path: '.env.local' });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.');
  }

  const target = url.replace(/:\/\/[^@]*@/, '://***:***@');
  console.log(`Applying migrations to ${target}`);

  const sql = postgres(url, { max: 1 });
  const start = Date.now();

  try {
    await migrate(drizzle(sql), { migrationsFolder: './db/migrations' });
    console.log(`Migrations applied in ${Date.now() - start}ms`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('Migration FAILED:', error);
  process.exit(1);
});
