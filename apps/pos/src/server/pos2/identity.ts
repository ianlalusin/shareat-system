import 'server-only';
/**
 * T-424 Ruling 3 + Acceptance 2 - who is calling. Every POS v2 route runs this first, in this order:
 *   body is a JSON object (400) -> `Authorization: Bearer <Firebase ID token>` (401) -> the Admin SDK verifies it (401; a token from
 *   another Firebase project is rejected there) -> `storeId` is present (400) -> `staff/{uid}` exists, is `status == 'active'` and lists the
 *   store in `assignedStoreIds` (403; a port of v1 `lib/server/staff-access.ts`, read via `git show e26d0c1:`, without its platform-admin bypass).
 * The body's `role` / `uid` / `staffRole` fields are NEVER read. The approval port is called only after this passes.
 */
import type { Pos2Deps } from './types';
import { fail } from './http';

export interface Caller {
  uid: string;
  /** staff/{uid}.role - from Firestore, never from the body. */
  role: string;
  name: string;
  username: string | null;
  storeId: string;
  body: Record<string, unknown>;
}

export async function authenticate(req: Request, deps: Pos2Deps): Promise<{ ok: true; caller: Caller } | { ok: false; response: Response }> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return { ok: false, response: fail(400, 'The request was not valid JSON.') };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, response: fail(400, 'The request body must be a JSON object.') };
  const body = parsed as Record<string, unknown>;

  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !match[1]) return { ok: false, response: fail(401, 'Sign in again to continue.') };
  let uid: string;
  try {
    ({ uid } = await deps.verifyIdToken(match[1]));
  } catch {
    return { ok: false, response: fail(401, 'Sign in again to continue.') };
  }
  if (!uid) return { ok: false, response: fail(401, 'Sign in again to continue.') };

  const storeId = typeof body.storeId === 'string' ? body.storeId.trim() : '';
  if (!storeId) return { ok: false, response: fail(400, 'Missing storeId.') };

  const snap = await deps.db.doc(`staff/${uid}`).get();
  const denied = fail(403, 'You do not have access to this store.');
  if (!snap.exists) return { ok: false, response: denied };
  const staff = (snap.data() ?? {}) as Record<string, unknown>;
  if (String(staff.status ?? '') !== 'active') return { ok: false, response: denied };
  const assigned = Array.isArray(staff.assignedStoreIds) ? staff.assignedStoreIds.map((v) => String(v)) : [];
  if (!assigned.includes(storeId)) return { ok: false, response: denied };

  const role = String(staff.role ?? '');
  const name = String(staff.displayName ?? staff.name ?? staff.username ?? uid);
  return { ok: true, caller: { uid, role, name, username: typeof staff.username === 'string' ? staff.username : null, storeId, body } };
}
