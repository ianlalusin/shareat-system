import 'server-only';
/**
 * T-424 Ruling 4 - builds the POS v2 server's ports from the box's environment, or says plainly that it is not configured.
 *
 *   POS_FIREBASE_SA_KEY_FILE   path to a service-account JSON file with Firestore write on the target Firebase project (never committed,
 *                              never a NEXT_PUBLIC_ variable). Its project is the one whose ID tokens this server accepts.
 *   DATABASE_URL               the ERP database (approvals, terminal links, till shifts).
 *   POS_ORG_ID                 the ERP organisation (uuid) this POS server belongs to. The server is single-organisation by design:
 *                              it never searches across organisations to find one. (A third setting beyond the spec's two - reported.)
 *
 * Missing or blank -> `{ ok: false, status: 503 }`, so a misconfigured box answers a plain sentence instead of crash-looping. Everything heavy
 * (firebase-admin, @shareat/db, @shareat/auth) is imported LAZILY here, so importing a route module touches neither the SDK nor the database.
 */
import type { LobbyTablet, Pos2Deps } from './types';

export const POS2_NOT_CONFIGURED = 'POS server is not configured';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cached: { key: string; deps: Pos2Deps } | null = null;

export async function getPos2Deps(env: Record<string, string | undefined>): Promise<{ ok: true; deps: Pos2Deps } | { ok: false; status: 503; error: string }> {
  const keyFile = (env.POS_FIREBASE_SA_KEY_FILE ?? '').trim();
  const databaseUrl = (env.DATABASE_URL ?? '').trim();
  const orgId = (env.POS_ORG_ID ?? '').trim();
  if (!keyFile || !databaseUrl || !UUID_SHAPE.test(orgId)) return { ok: false, status: 503, error: POS2_NOT_CONFIGURED };

  const key = `${keyFile}|${orgId}`;
  if (cached && cached.key === key) return { ok: true, deps: cached.deps };
  try {
    const deps = await buildDeps(keyFile, orgId);
    cached = { key, deps };
    return { ok: true, deps };
  } catch (err) {
    console.error('[pos2] could not start:', err instanceof Error ? err.message : 'unknown error');
    return { ok: false, status: 503, error: POS2_NOT_CONFIGURED };
  }
}

async function buildDeps(keyFile: string, orgId: string): Promise<Pos2Deps> {
  const [{ readFileSync }, { randomUUID }] = [await import('node:fs'), await import('node:crypto')];
  const { initializeApp, getApps, cert } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getFirestore, FieldValue, FieldPath } = await import('firebase-admin/firestore');
  const auth = await import('@shareat/auth');
  const dbPkg = await import('@shareat/db');

  const credential = JSON.parse(readFileSync(keyFile, 'utf8')) as { project_id?: string };
  if (!credential.project_id) throw new Error('the service-account file has no project_id');
  const app = getApps().find((a) => a.name === 'pos2') ?? initializeApp({ credential: cert(credential as never), projectId: credential.project_id }, 'pos2');
  const firestore = getFirestore(app);
  const adminAuth = getAuth(app);

  return {
    db: {
      doc: (path: string) => firestore.doc(path),
      collection: (path: string) => firestore.collection(path),
      runTransaction: (fn) => firestore.runTransaction(fn as never),
      FieldValue: {
        serverTimestamp: () => FieldValue.serverTimestamp(),
        increment: (n: number) => FieldValue.increment(n),
        delete: () => FieldValue.delete(),
        arrayUnion: (...v: unknown[]) => FieldValue.arrayUnion(...v),
        arrayRemove: (...v: unknown[]) => FieldValue.arrayRemove(...v),
      },
      FieldPath: { documentId: () => FieldPath.documentId() },
    },
    // The Admin SDK checks the token's audience against this app's project: a token from another Firebase project is rejected here.
    verifyIdToken: async (token) => {
      const decoded = await adminAuth.verifyIdToken(token);
      return { uid: decoded.uid };
    },
    approveManagerPin: async ({ posStoreId, deviceId, pin }) => {
      try {
        const link = await dbPkg.withOrgPrincipal(orgId, (tx) => auth.resolvePosTerminalLink(tx, { orgId, posStoreId, deviceId }));
        const approved = await auth.verifyPosManagerApproval(null, {
          orgId,
          erpStoreId: link.erpStoreId,
          pin,
          terminalPersonId: link.terminalPersonId,
          deviceId,
        });
        return { ok: true, approverPersonId: approved.approverPersonId, terminalNo: link.terminalNo };
      } catch (err) {
        if (err instanceof auth.AuthenticationError) return { ok: false, message: err.message };
        throw err;
      }
    },
    // T-477 (DEF-771): the same trusted ERP link the PIN path uses, with no PIN. No link (or an unusable device id) is null; anything else propagates.
    resolveTerminalNo: async ({ posStoreId, deviceId }) => {
      try {
        const link = await dbPkg.withOrgPrincipal(orgId, (tx) => auth.resolvePosTerminalLink(tx, { orgId, posStoreId, deviceId }));
        return link.terminalNo;
      } catch (err) {
        if (err instanceof auth.AuthenticationError) return null;
        throw err;
      }
    },
    openTillShift: async (posStoreId) =>
      dbPkg.withOrgPrincipal(orgId, async (tx) => {
        const link = await dbPkg.posV1Repo.getLinkByPosStoreId(tx, orgId, posStoreId);
        if (!link || link.unlinkedAt) return null;
        const shift = await dbPkg.tillShiftsRepo.openShiftFor(tx, orgId, link.storeId);
        return shift ? { openedAtMs: shift.openedAt.getTime() } : null;
      }),
    // T-455 S5: the tablet's lobby moves. Trust chain = the route's token + staff assignment, then the tablet's ACTIVE terminal link here.
    lobby: buildLobbyPort(orgId, auth, dbPkg, async () => import('@shareat/domain')),
    nowMs: () => Date.now(),
    newId: () => firestore.collection('_ids').doc().id ?? randomUUID(),
  };
}

/**
 * T-455 S5 - the lobby port: each move runs in ONE `withOrgPrincipal(orgId)` transaction. The domain's `LobbyRefusal` already carries
 * `name === 'LobbyRefusal'` and a one-sentence `userMessage`, so it propagates as is and the handler answers it as a 409.
 * The domain package is imported lazily, like the other heavy packages, so importing a route module loads none of it.
 */
function buildLobbyPort(
  orgId: string,
  auth: typeof import('@shareat/auth'),
  dbPkg: typeof import('@shareat/db'),
  loadDomain: () => Promise<typeof import('@shareat/domain')>,
): Pos2Deps['lobby'] {
  const actorOf = (a: LobbyTablet) => ({ orgId, erpStoreId: a.erpStoreId, terminalPersonId: a.terminalPersonId, cashierName: a.cashierName });
  return {
    resolveTablet: async ({ posStoreId, deviceId }) => {
      try {
        const link = await dbPkg.withOrgPrincipal(orgId, (tx) => auth.resolvePosTerminalLink(tx, { orgId, posStoreId, deviceId }));
        return { erpStoreId: link.erpStoreId, terminalPersonId: link.terminalPersonId };
      } catch (err) {
        if (err instanceof auth.AuthenticationError) return null;
        throw err;
      }
    },
    list: async (a) => {
      const d = await loadDomain();
      return dbPkg.withOrgPrincipal(orgId, (tx) => d.listForTerminal(tx, actorOf(a)));
    },
    park: async (a, i) => {
      const d = await loadDomain();
      return dbPkg.withOrgPrincipal(orgId, (tx) => d.parkForTerminal(tx, actorOf(a), i));
    },
    call: async (a, i) => {
      const d = await loadDomain();
      return dbPkg.withOrgPrincipal(orgId, (tx) => d.callForTerminal(tx, actorOf(a), i.entryId));
    },
    seat: async (a, i) => {
      const d = await loadDomain();
      return dbPkg.withOrgPrincipal(orgId, (tx) => d.seatForTerminal(tx, actorOf(a), i));
    },
    remove: async (a, i) => {
      const d = await loadDomain();
      return dbPkg.withOrgPrincipal(orgId, (tx) => d.removeForTerminal(tx, actorOf(a), i.entryId));
    },
    pause: async (a, i) => {
      const d = await loadDomain();
      return dbPkg.withOrgPrincipal(orgId, (tx) => d.setLobbyPausedForTerminal(tx, actorOf(a), i.paused));
    },
  };
}
