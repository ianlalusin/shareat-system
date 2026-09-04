/**
 * The Firestore adapters for the hot lane. T-159 and T-181.
 *
 * ## ⭐ Why this is its own package
 *
 * `packages/storage-firebase` states the rule and this follows it exactly:
 *
 * > *"`packages/domain` owns the `StorageDriver` interface and **must not own a cloud SDK** — the
 * > same isolation `@shareat/etl-firestore` exists for. Domain code depends on the shape; exactly
 * > one package depends on `firebase-admin`."*
 *
 * ⚠️ `CLAUDE.md` puts the publisher and ingestor at `packages/domain/sync/`. That line is read here
 * as *the logic*, not *the adapter* — the precedent above is set twice already, and a `firebase-admin`
 * import inside `packages/domain` would make every consumer of the domain package carry a cloud SDK.
 * Reported in T-159 §1 rather than done silently.
 *
 * ## ⛔ The Admin SDK bypasses security rules entirely
 *
 * That is what makes `allow write: if false` on every mirror path free — the publisher is not
 * subject to it. It also means **this file is the only thing standing between a bug and a rewritten
 * mirror**, so it writes exactly the paths the driver interface hands it and constructs none of
 * its own.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { MirrorDocument, MirrorDriver } from '@shareat/domain';
import type { TerminalIdentityDriver } from '@shareat/domain';
import type { InboxDriver } from '@shareat/domain';

/** Fixed name so a second call reuses the app — `initializeApp` is a singleton-per-name API. */
const APP_NAME = 'shareat-sync';

interface ServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
}

function loadServiceAccount(env: NodeJS.ProcessEnv = process.env): ServiceAccountJson {
  const inline = env.FIREBASE_SERVICE_ACCOUNT_KEY?.trim();
  const file = env.FIREBASE_SERVICE_ACCOUNT_KEY_FILE?.trim();

  // ⛔ Setting BOTH is rejected rather than silently resolved — "which key did it actually use" is
  // the worst question to have to ask about a production credential (.env.example says so too).
  if (inline && file) {
    throw new Error(
      'Both FIREBASE_SERVICE_ACCOUNT_KEY and FIREBASE_SERVICE_ACCOUNT_KEY_FILE are set. Set exactly one.',
    );
  }
  // ⛔ T-204/DEF-151 fix: `??` treats `''` as PRESENT (nullish-coalescing only falls through on
  // null/undefined), so `FIREBASE_SERVICE_ACCOUNT_KEY=` set-but-blank in `.env.local` (the normal
  // shape when `_FILE` is the one actually configured, per this project's own "preferred" env
  // convention) fed `JSON.parse('')` an empty string and failed every real call with a misleading
  // "did not parse as JSON" — never caught before because DEF-132 established nothing had ever
  // called this outside a test. `||` treats blank the same as absent, matching `file`'s own
  // truthiness check three lines up.
  const raw = inline || readKeyFile(file);
  try {
    return JSON.parse(raw) as ServiceAccountJson;
  } catch {
    // ⚠️ Never include the parse error's own message: some engines echo a snippet of the offending
    // text, and a credential file is exactly the content that must never reach a log.
    throw new Error('The Firebase service account did not parse as JSON.');
  }
}

function readKeyFile(path: string | undefined): string {
  if (!path) {
    throw new Error(
      'No Firebase service account configured. Set FIREBASE_SERVICE_ACCOUNT_KEY_FILE (preferred) ' +
        'or FIREBASE_SERVICE_ACCOUNT_KEY. See .env.example.',
    );
  }
  const resolved = isAbsolute(path) ? path : join(process.cwd(), path);
  if (!existsSync(resolved)) throw new Error(`Firebase service account file not found at ${resolved}`);
  return readFileSync(resolved, 'utf8');
}

let cached: App | undefined;

function app(): App {
  if (cached) return cached;
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) {
    cached = existing;
    return cached;
  }
  const sa = loadServiceAccount();
  cached = initializeApp(
    {
      credential: cert({
        projectId: sa.project_id,
        clientEmail: sa.client_email,
        privateKey: sa.private_key.replace(/\\n/g, '\n'),
      }),
      projectId: sa.project_id,
    },
    APP_NAME,
  );
  return cached;
}

const db = (): Firestore => getFirestore(app());

// -------------------------------------------------------------------------------------
// T-181 — the mirror driver
// -------------------------------------------------------------------------------------

/**
 * ⭐ **A write that would go backwards is refused inside the transaction**, not before it.
 *
 * §5.1: *"The publisher writes only when `srcVersion` is newer."* Checking then writing outside a
 * transaction loses the race between two relay instances, and the loser silently overwrites the
 * winner with older truth — which is the one thing a mirror must never do.
 */
export function createFirestoreMirrorDriver(): MirrorDriver {
  return {
    async publish(documents: readonly MirrorDocument[]): Promise<void> {
      const firestore = db();
      for (const document of documents) {
        const ref = firestore.doc(document.path);
        await firestore.runTransaction(async (t) => {
          const snapshot = await t.get(ref);
          const existing = snapshot.exists ? (snapshot.data()?.srcVersion as string | undefined) : undefined;
          if (existing !== undefined && BigInt(existing) >= BigInt(document.srcVersion)) return;

          if (document.deleted) {
            // ⛔ A tombstone, never a hard delete. §5.1: an offline device must be able to LEARN
            // that a record went away; a deletion it never saw leaves it holding the stale row.
            t.set(ref, { deletedAt: FieldValue.serverTimestamp(), srcVersion: document.srcVersion });
            return;
          }
          t.set(ref, {
            ...document.data,
            srcVersion: document.srcVersion,
            syncedAt: FieldValue.serverTimestamp(),
            deletedAt: null,
          });
        });
      }
    },
  };
}

// -------------------------------------------------------------------------------------
// T-159 — the terminal identity driver
// -------------------------------------------------------------------------------------

/**
 * Mints the one-time custom token a terminal exchanges for a real Firebase session, and disables
 * the auth user on revocation.
 *
 * ⚠️ The claims minted here are exactly what `firestore.rules` reads: `deviceId` and `storeId`.
 * Changing either name breaks the rules silently, which is why the rules suite asserts a
 * cross-store read fails rather than only asserting the happy path.
 */
export function createFirestoreTerminalDriver(): TerminalIdentityDriver {
  return {
    async mintCustomToken({ firebaseUid, claims }) {
      // ⚠️ Returned to the caller once and never stored. It is displayed as a QR code and is not
      // logged — the same rule `sessions.tokenHash` already follows for a person's token.
      return getAuth(app()).createCustomToken(firebaseUid, claims);
    },
    async disable(firebaseUid) {
      // ⛔ DISABLE, never delete. Deleting frees the uid for reuse and loses the audit link from
      // every event the terminal ever wrote. Disabling makes the next token refresh fail, which is
      // what revocation actually needs.
      try {
        await getAuth(app()).updateUser(firebaseUid, { disabled: true });
      } catch (error) {
        // A terminal provisioned but never signed in has no auth user yet. Revoking it is still a
        // legitimate act — and the Postgres row is what the ingestor checks, so nothing is weaker.
        if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
      }
    },
  };
}

// -------------------------------------------------------------------------------------
// T-204 — the inbox driver, T-182's own missing half. DEF-132: nothing has ever called
// `ingestEvents` against a live stream of real `/inbox` documents; this is what reads them.
// -------------------------------------------------------------------------------------

/**
 * ⚠️ **Deliberately no `orderBy` and no composite index.** `where('processedAt','==',null)` alone
 * needs no `firestore.indexes.json` entry — Firestore auto-indexes single-field equality. Adding
 * an `orderBy(occurredAt)` would need a composite index, which needs a real deploy
 * (`firebase deploy --only firestore:indexes`) against the shared `shareat-hub-v2` project, and
 * this project has already recorded a live incident of a blind index deploy deleting ~44
 * unrelated indexes (`reference_pos_firestore_indexes_drift`). Not worth it for a job that
 * reprocesses whatever's left every run regardless of order.
 *
 * ⚠️ **A quarantined event is still "processed" for this driver's purposes.** `markProcessed` with
 * `punchId: null` on anything `ingestEvents` decided NOT to turn into a punch (malformed, unknown
 * device, etc.) — T-182 invariant 6 already establishes that a quarantined event keeps its
 * document; this driver just needs to stop re-reading it every run. The quarantine TABLE itself,
 * not this Firestore flag, is what a manager's screen reads to act on it.
 */
export function createFirestoreInboxDriver(): InboxDriver {
  return {
    async readUnprocessed({ limit }) {
      const snap = await db().collection('inbox').where('processedAt', '==', null).limit(limit).get();
      return snap.docs.map((d) => ({ docId: d.id, data: d.data() }));
    },
    async markProcessed({ docId, punchId }) {
      await db().collection('inbox').doc(docId).update({
        processedAt: FieldValue.serverTimestamp(),
        ...(punchId ? { punchId } : {}),
      });
    },
  };
}
