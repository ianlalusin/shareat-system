/**
 * T-531 R5 - the REAL writer of the December bridge to v1 (bible row 436). SERVER-ONLY: it uses `firebase-admin`, which is in `next.config.js`'s
 * `serverExternalPackages` and must stay out of every client bundle.
 *
 * It writes ONE Firestore document (`stores/{posStoreId}/analytics/{yyyymmdd}`) in the POS project, the one v1's `api/external/sales` reads, using the
 * service-account key FILE named by `POS_FIREBASE_SA_KEY_FILE` (a path, never the key: the key never enters an env var, a log line or an answer). With no key file
 * the writer refuses "The v1 bridge is not configured." and the day close it follows still succeeds (the Till tab then shows Resend).
 *
 * Its own named admin app, so it never inherits the identity project's or the storage driver's credential (`shareat-auth`, `shareat-storage`).
 * The domain (`packages/domain/src/pos/day-close.ts`) takes a writer as a parameter, so a test injects a fake and CI never reaches Firestore.
 */
import { readFileSync } from 'node:fs';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { refuse } from '@shareat/db';
import type { V1BridgeWriter } from '@shareat/domain';

const APP_NAME = 'shareat-v1-bridge';
export const V1_BRIDGE_NOT_CONFIGURED = 'The v1 bridge is not configured.';

function bridgeApp(keyFile: string): App {
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) return existing;
  const key = JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, unknown>;
  return initializeApp({ credential: cert(key as Parameters<typeof cert>[0]) }, APP_NAME);
}

export function createV1BridgeWriter(env: Record<string, string | undefined> = process.env): V1BridgeWriter {
  return {
    async set(path, data, opts) {
      const keyFile = env.POS_FIREBASE_SA_KEY_FILE?.trim();
      // A test run never writes into v1, whatever the environment holds.
      if (!keyFile || process.env.VITEST) throw refuse('v1 bridge: POS_FIREBASE_SA_KEY_FILE is not set', V1_BRIDGE_NOT_CONFIGURED);
      await getFirestore(bridgeApp(keyFile)).doc(path).set(data, { merge: opts.merge });
    },
  };
}
