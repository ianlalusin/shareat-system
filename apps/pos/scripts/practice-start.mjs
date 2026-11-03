// Starts the POS dev server as the PRACTICE COPY: local emulators on free ports, no live Firebase, throwaway Postgres.
//   node --env-file=<repo>/.env.local scripts/practice-start.mjs      (the env file only supplies TEST_DATABASE_URL's server and login)
// Everything here is synthetic. The service-account file it makes is a random throwaway key that no Google account knows.
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPracticeEnv, resolvePracticeDatabaseUrl } from '../../../scripts/lib/practice-env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'emulator', '.practice');
const keyFile = join(dir, 'practice-sa.json');
const ports = { auth: '9189', firestore: '8180', storage: '9299', pos: '9019' };

if (!existsSync(keyFile)) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '*\n');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  writeFileSync(keyFile, JSON.stringify({ type: 'service_account', project_id: 'demo-shareat-pos2', private_key_id: 'practice', private_key: privateKey,
    client_email: 'practice@demo-shareat-pos2.iam.gserviceaccount.com', client_id: '0' }));
}

const databaseUrl = resolvePracticeDatabaseUrl(process.env);
if (!databaseUrl) console.warn('No database URL: /api/pos2 routes will answer "POS server is not configured". Set POS_PRACTICE_DATABASE_URL or TEST_DATABASE_URL.');

// The practice company id: written by scripts/practice-erp-seed.ts (emulator/.practice/org-id.txt); the old fixed id is the fallback.
const orgFile = join(dir, 'org-id.txt');
const orgId = existsSync(orgFile) ? readFileSync(orgFile, 'utf8').trim() : '00000000-0000-4000-8000-000000000455';

// F43: the child NEVER inherits a database address from the shell; buildPracticeEnv forces DATABASE_URL, drops every other *DATABASE_URL, and refuses a non-local / non-_test one.
const env = buildPracticeEnv(process.env, databaseUrl, {
  POS_EMULATOR_MODE: '1', POS_EMULATOR_HOST: '127.0.0.1',
  POS_EMULATOR_API_PORT: ports.pos, POS_EMULATOR_AUTH_PORT: ports.auth, POS_EMULATOR_FIRESTORE_PORT: ports.firestore, POS_EMULATOR_STORAGE_PORT: ports.storage,
  // Server side (firebase-admin) talks to the same local emulators.
  FIRESTORE_EMULATOR_HOST: `127.0.0.1:${ports.firestore}`, FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${ports.auth}`, GCLOUD_PROJECT: 'demo-shareat-pos2',
  POS_FIREBASE_SA_KEY_FILE: keyFile, POS_ORG_ID: orgId,
});
delete env.NEXT_PUBLIC_API_BASE; delete env.NEXT_PUBLIC_POS2_API_BASE; delete env.POS_LOBBY_JOIN_ORIGIN;

const next = join(root, '..', '..', 'node_modules', 'next', 'dist', 'bin', 'next');
const child = spawn(process.execPath, [next, 'dev', '--webpack', '-p', ports.pos, '-H', '127.0.0.1'], { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
