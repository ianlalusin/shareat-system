/**
 * Integration tests run against a REAL PostgreSQL, never a mock
 * (PROJECT_BIBLE.md §9 rule 3).
 *
 * They point at TEST_DATABASE_URL, which is truncated between runs — so it must never
 * be a database holding real data. This guard makes that mistake impossible rather than
 * merely discouraged.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests need a real, disposable Postgres. ' +
      'See .env.example.',
  );
}

if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run integration tests against ${url.replace(/:\/\/[^@]*@/, '://***@')} — ` +
      'the database name must contain "_test". These tests TRUNCATE tables.',
  );
}

process.env.DATABASE_URL = url;
