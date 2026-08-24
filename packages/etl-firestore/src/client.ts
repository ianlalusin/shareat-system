/**
 * client.ts — credential loading -> an initialised Firestore app.
 * docs/tasks/114a-firestore-reader-and-capture.md Contract §1.
 *
 * Reuses `loadCaptureCredentials` from `packages/etl/src/capture.ts` VERBATIM — the task
 * spec is explicit: "do not re-implement credential handling, and do not read
 * FIREBASE_SERVICE_ACCOUNT_KEY" (that is `@shareat/core/env`'s production Firebase Admin
 * credential, a different credential for a different purpose). This module adds nothing but
 * turning the already-validated ERP service-account JSON into an initialised `firebase-admin`
 * Firestore client.
 *
 * **This task targets the ERP project only** (Contract §1). `loadCaptureCredentials`
 * requires BOTH `hubSaKey` and `erpSaKey` to be present before it returns anything at all —
 * that is its existing, unmodified contract — so the hub key is necessarily loaded here too,
 * but it is never read past the `'skipped' in creds` check: nothing below constructs an app,
 * a credential object, or a client from it. The hub/POS project stays untouched.
 */
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { loadCaptureCredentials, type CaptureSkipped, type FileReader } from '@shareat/etl/capture';

import type { FirestoreClientLike } from './reader';

export interface ErpFirestoreClientReady {
  ready: true;
  firestore: FirestoreClientLike;
}

export type ErpFirestoreClientResult = ErpFirestoreClientReady | CaptureSkipped;

/** Fixed name so a second call in the same process reuses the existing app instead of
 *  throwing "app already exists" — `initializeApp` is otherwise a singleton-per-name API. */
const APP_NAME = 'shareat-etl-firestore-erp';

/**
 * Builds a read-only Firestore client for the ERP project (`studio-7300228488-a394e`) ONLY.
 *
 * Never throws on missing or malformed credentials — propagates `loadCaptureCredentials`'s
 * skip result UNCHANGED (invariant 13: "Missing credentials produce the existing skip
 * result, not a crash"). The JSON.parse below is defensive, not a live path in this repo's
 * `.env.local` (which sets `CAPTURE_ERP_SA_KEY_FILE`, and `loadCaptureCredentials` already
 * validates that a FILE-sourced credential parses as JSON and looks like a service account
 * before returning it) — but it is reachable if a caller supplies `CAPTURE_ERP_SA_KEY`
 * inline, which `loadCaptureCredentials` does NOT shape-check. Its catch never includes the
 * parse error's own message in what it throws, only a fixed sentence — some JS engines echo
 * a snippet of the offending text in a `SyntaxError.message`, and a credential file is
 * exactly the content that must never appear in an error (task's "do not print, log, or copy
 * key material").
 */
export function createErpFirestoreClient(
  envSource: Readonly<Record<string, string | undefined>> = process.env,
  readFile?: FileReader,
): ErpFirestoreClientResult {
  const creds = readFile ? loadCaptureCredentials(envSource, readFile) : loadCaptureCredentials(envSource);
  if ('skipped' in creds) return creds;

  let raw: { project_id: string; client_email: string; private_key: string };
  try {
    raw = JSON.parse(creds.erpSaKey) as typeof raw;
  } catch {
    throw new Error(
      'createErpFirestoreClient: CAPTURE_ERP_SA_KEY does not parse as JSON. This should be ' +
        'unreachable for the FILE form (CAPTURE_ERP_SA_KEY_FILE), which loadCaptureCredentials ' +
        'already validates — check the inline CAPTURE_ERP_SA_KEY form if that is what is set.',
    );
  }
  // firebase-admin's cert() wants camelCase (ServiceAccount); the raw JSON key file is
  // snake_case, same shape assertLooksLikeServiceAccount already validated it carries.
  const serviceAccount = {
    projectId: raw.project_id,
    clientEmail: raw.client_email,
    privateKey: raw.private_key,
  };

  const existing = getApps().find((app) => app.name === APP_NAME);
  const app =
    existing ?? initializeApp({ credential: cert(serviceAccount), projectId: raw.project_id }, APP_NAME);

  return { ready: true, firestore: getFirestore(app) };
}
