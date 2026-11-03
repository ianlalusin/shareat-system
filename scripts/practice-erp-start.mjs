// Starts / seeds the PRACTICE ERP: a local ERP on port 9008 against the throwaway database shareat_test_pospractice, with the local Firebase
// emulators for sign-in and NO real key, project, host or Firebase. Everything is synthetic.
//   node scripts/practice-erp-start.mjs seed [--device=<uuid>]   (fills the fake company; safe to repeat)
//   node scripts/practice-erp-start.mjs session <personId>       (prints a 1-hour login cookie value for curl checks)
//   node scripts/practice-erp-start.mjs dev                      (the ERP on http://127.0.0.1:9008; leave running)
// Run from the repo root. TEST_DATABASE_URL (or POS_PRACTICE_DATABASE_URL) must be in the shell, e.g. via
//   node --env-file=<main checkout>/.env.local scripts/practice-erp-start.mjs dev
// The env file only supplies the local Postgres server and login; the child never inherits a database address (scripts/lib/practice-env.mjs).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPracticeEnv, resolvePracticeDatabaseUrl } from './lib/practice-env.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(repo, 'apps', 'pos', 'emulator', '.practice');
const mode = process.argv[2];
if (!['seed', 'dev', 'session', 'check-approval'].includes(mode ?? '')) {
  console.error('usage: node scripts/practice-erp-start.mjs seed [--device=<uuid>] | dev | session <personId>');
  process.exit(2);
}

mkdirSync(dir, { recursive: true });
if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
const secretFile = join(dir, 'erp-session-secret.txt');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(48).toString('base64'));
const sessionSecret = readFileSync(secretFile, 'utf8').trim();

const databaseUrl = resolvePracticeDatabaseUrl(process.env);
if (!databaseUrl) {
  console.error('No database URL. Set TEST_DATABASE_URL (e.g. node --env-file=<repo>\\.env.local ...) or POS_PRACTICE_DATABASE_URL.');
  process.exit(2);
}

const authPort = process.env.POS_EMULATOR_AUTH_PORT || '9189';
const env = buildPracticeEnv(process.env, databaseUrl, {
  NODE_ENV: 'development',
  PRACTICE_ERP: '1',
  SESSION_SECRET: sessionSecret,
  // Same Auth emulator and project as the practice POS. The "keys" are placeholders: the emulator accepts anything.
  FIREBASE_PROJECT_ID: 'demo-shareat-pos2',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-shareat-pos2',
  NEXT_PUBLIC_FIREBASE_API_KEY: 'emulator-only-not-a-real-key',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'localhost',
  NEXT_PUBLIC_FIREBASE_APP_ID: '1:0:web:practice',
  NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: `127.0.0.1:${authPort}`,
  FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`,
  POS_EMULATOR_AUTH_PORT: authPort,
  NEXT_PUBLIC_FIREBASE_AUTH_PORT: authPort,
});
// No real Firebase credentials, storage bucket or POS keys may reach the practice ERP.
for (const k of ['FIREBASE_SERVICE_ACCOUNT_KEY', 'FIREBASE_SERVICE_ACCOUNT_KEY_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', 'POS_API_URL', 'POS_API_KEY', 'CAPTURE_ERP_SA_KEY_FILE', 'CAPTURE_HUB_SA_KEY_FILE', 'CAPTURE_SALT',
  'DEV_TERMINAL_EMAIL', 'DEV_TERMINAL_PASSWORD', 'DEV_TERMINAL_UID', 'FB_DEV_TERMINAL_EMAIL', 'FB_DEV_TERMINAL_PASSWORD', 'FB_DEV_TERMINAL_UID']) delete env[k];

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = mode === 'seed'
  ? ['tsx', 'scripts/practice-erp-seed.ts', ...process.argv.slice(3)]
  : mode === 'session'
    ? ['tsx', 'scripts/practice-erp-session.ts', ...process.argv.slice(3)]
    : mode === 'check-approval'
      ? ['tsx', 'scripts/practice-erp-check-approval.ts']
      : ['next', 'dev', '--port', '9008', '--hostname', '127.0.0.1'];
const cwd = mode !== 'dev' ? repo : join(repo, 'apps', 'erp');
const child = spawn(npx, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
