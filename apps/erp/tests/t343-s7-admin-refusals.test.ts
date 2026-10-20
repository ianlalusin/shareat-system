/**
 * T-343 S7 — DEF-452, admin/users and admin/access-defaults. `docs/tasks/343-def-417-human-
 * readable-refusals.md` §S7. Companion to `t343-s7-wrapper-refusals.test.ts` (the other 11
 * screens); split out because these two keep the most local branches and need `@shareat/auth`
 * mocked partially, per the spec's own harness note.
 *
 * ⛔ TESTER, not BUILDER. Both files' local `errorMessage` still key on `authorize()`'s raw text
 * (`may not '<cap>'`, `has no active role`) and on two `recordGone`-shaped tails
 * (`^revokeCredential:`, `does not exist or is already revoked`) BEFORE the shared, presentable-
 * aware fallback — expected red until the builder adds the `isPresentable`-first check and deletes
 * the dead branches (S7 change 1). P4/P5's `sessions.ts` kind change (`'credential'` →
 * `'sign-in account'`) is NOT exercised here at all — that is P5, in
 * `packages/auth/tests/integration/sessions.test.ts`'s new describe block; this file's P4(b) only
 * proves the WRAPPER routes a `recordGone(raw, 'sign-in account')`-shaped error to `goneSentence`,
 * using the real primitive directly, never the repo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paramsOf } from './helpers/flash-jar';

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
  clearSessionCookie: vi.fn(async () => undefined),
}));

vi.mock('@/lib/constraint-messages', async () => {
  return await import('../src/lib/constraint-messages');
});

// T-412: revoking a grant and unlinking a sign-in account now ask the person to retype a name the SERVER loads. This file is about how a
// REFUSAL is carried, so the loaded names are stubbed and the forms below type them (the real path: t412-destructive-actions.test.ts).
vi.mock('@/lib/destructive', async () => (await import('./helpers/destructive-mocks')).destructiveLibMock());

// Partial mock, exactly as the spec's own harness note prescribes — `authorize`/`capabilityTitle`
// stay real (S6b's label logic, and `setStoreScopeAction`'s own `authorize()` call, neither driven
// here). `grantCapabilityAsActor`/`assignRoleAsActor`/`linkFirebaseCredential`/`unlinkCredential`
// are the four calls this file's rows actually drive.
const grantCapabilityAsActor = vi.fn();
const assignRoleAsActor = vi.fn();
const linkFirebaseCredential = vi.fn();
const unlinkCredential = vi.fn();
vi.mock('@shareat/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/auth')>();
  return {
    ...actual,
    grantCapabilityAsActor: (...args: unknown[]) => grantCapabilityAsActor(...args),
    assignRoleAsActor: (...args: unknown[]) => assignRoleAsActor(...args),
    linkFirebaseCredential: (...args: unknown[]) => linkFirebaseCredential(...args),
    unlinkCredential: (...args: unknown[]) => unlinkCredential(...args),
    // `setCapabilityGrantAction`'s REVOKE branch calls the real `authorize()` directly (its own
    // header: deliberately not self-checked, unlike the grant branch). Real `authorize()` reads
    // `accessRepo.activeRoleForPerson` against a real drizzle `tx`, which the fake `tx = {}`
    // `withOrgPrincipal` passthrough below cannot satisfy — P4(a) is about `revokeGrantById`'s
    // throw, not this gate, so it is stubbed permissive here.
    authorize: vi.fn(async () => undefined),
    can: vi.fn(async () => true),
  };
});

// `authorize()` (kept real, above) calls several other `accessRepo` methods internally
// (`activeRoleForPerson` etc.) on the revoke branch's own `authorize(tx, actor, 'grant_capability',
// {})` call — `importOriginal` keeps every one of those real and overrides only the single method
// P4(a) needs to control.
const revokeGrantById = vi.fn();
vi.mock('@shareat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/db')>();
  return {
    ...actual,
    accessRepo: {
      ...actual.accessRepo,
      revokeGrantById: (...args: unknown[]) => revokeGrantById(...args),
    },
    destructiveTargetsRepo: { targetOf: vi.fn(async () => ({ storeId: null, name: 'void_expense', status: null })) },
  };
});

vi.mock('../src/app/admin/users/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/admin/users/lib')>();
  return {
    ...actual,
    withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
  };
});

const setPositionDefault = vi.fn();
vi.mock('@shareat/domain', () => ({
  assertFieldRules: () => ({}),
  setPositionDefault: (...args: unknown[]) => setPositionDefault(...args),
  retireStorePosition: vi.fn(),
}));

vi.mock('../src/app/admin/access-defaults/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/admin/access-defaults/lib')>();
  return {
    ...actual,
    withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
    activeDefaultsAtStore: vi.fn(async () => []),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

function errorOf(to: string): string | null {
  return paramsOf(to).get('error');
}

function pgError(message: string, code: string, constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error(message), { code, constraint });
}

async function authErr(capability: string, S: string) {
  const { AuthorizationError } = await import('../../../packages/auth/src/errors');
  return new AuthorizationError(`authorize: role 'staff' may not '${capability}'`, capability as never, S);
}

// ===========================================================================================
// P1 — the remaining 3 of the 30 deleted `may not '<cap>'` branches.
// ===========================================================================================

describe('P1 — admin/users and access-defaults: the S2 userMessage wins, not the local sentence', () => {
  it(
    'admin/users — manage_users',
    async () => {
      const S = 'S2 sentence for manage_users.';
      assignRoleAsActor.mockRejectedValueOnce(await authErr('manage_users', S));
      const { assignRoleAction } = await import('../src/app/admin/users/actions');
      const fd = new FormData();
      fd.set('personId', 'person-2');
      fd.set('role', 'manager');
      const to = await expectRedirectTo(() => assignRoleAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );

  it(
    'admin/users — grant_capability',
    async () => {
      const S = 'S2 sentence for grant_capability.';
      grantCapabilityAsActor.mockRejectedValueOnce(await authErr('grant_capability', S));
      const { setCapabilityGrantAction } = await import('../src/app/admin/users/actions');
      const fd = new FormData();
      fd.set('personId', 'person-2');
      fd.append('capability', 'post_journal_entry');
      fd.set('granted', 'true');
      const to = await expectRedirectTo(() => setCapabilityGrantAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );

  it(
    'access-defaults — grant_capability',
    async () => {
      const S = 'S2 sentence for grant_capability.';
      setPositionDefault.mockRejectedValueOnce(await authErr('grant_capability', S));
      const { toggleDefaultAction } = await import('../src/app/admin/access-defaults/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('positionId', 'pos-1');
      fd.set('capability', 'record_sale');
      fd.set('on', 'true');
      const to = await expectRedirectTo(() => toggleDefaultAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

// ===========================================================================================
// P2 — the one other authorize-shaped branch outside `may not '`: `has no active role`.
// ===========================================================================================

describe('P2 — access-defaults: a presentable "has no active role" error wins over the local sentence', () => {
  it(
    'error === S, not "Your account has no active role…" (was the bypass sentence)',
    async () => {
      const { refuse } = await import('../../../packages/db/src/refusal');
      const S = 'Your account has no active role right now, so nothing here can be granted or changed.';
      setPositionDefault.mockRejectedValueOnce(
        refuse(`authorize: person ${'0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b'} has no active role in org org-1`, S),
      );
      const { toggleDefaultAction } = await import('../src/app/admin/access-defaults/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('positionId', 'pos-1');
      fd.set('capability', 'record_sale');
      fd.set('on', 'true');
      const to = await expectRedirectTo(() => toggleDefaultAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

// ===========================================================================================
// P3 — one row per file that keeps a branch: a presentable error whose raw text also matches the
// kept branch's own regex still renders the userMessage.
// ===========================================================================================

describe('P3 — a presentable error beats a kept local branch, even when its raw text also matches that branch', () => {
  it(
    'admin/users — person_credentials_external_id_unique via refuse(raw, S) still renders S',
    async () => {
      const { refuse } = await import('../../../packages/db/src/refusal');
      const S = 'That Firebase account is already in use elsewhere.';
      linkFirebaseCredential.mockRejectedValueOnce(
        refuse('linkFirebaseCredential: violates unique constraint "person_credentials_external_id_unique"', S),
      );
      const { linkFirebaseAction } = await import('../src/app/admin/users/actions');
      const fd = new FormData();
      fd.set('personId', 'person-2');
      fd.set('uid', 'firebase-uid-1');
      const to = await expectRedirectTo(() => linkFirebaseAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );

  it(
    'access-defaults — "…does not exist in this organisation…" via refuse(raw, S) still renders S',
    async () => {
      const { refuse } = await import('../../../packages/db/src/refusal');
      const S = 'That position does not exist here.';
      setPositionDefault.mockRejectedValueOnce(
        refuse('setPositionDefault: position pos-1 does not exist in this organisation', S),
      );
      const { toggleDefaultAction } = await import('../src/app/admin/access-defaults/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('positionId', 'pos-1');
      fd.set('capability', 'record_sale');
      fd.set('on', 'true');
      const to = await expectRedirectTo(() => toggleDefaultAction(fd));
      expect(errorOf(to)).toBe(S);
    },
    30000,
  );
});

// ===========================================================================================
// P4 — 2 rows: the two `recordGone`-shaped tails admin/users keeps, built with the real
// primitives, whose sentence must reach the screen unbypassed.
// ===========================================================================================

describe('P4 — admin/users: a recordGone-shaped presentable error (grant, then credential) renders goneSentence', () => {
  it(
    '(a) revokeGrantById: a grant already revoked renders goneSentence(\'grant\')',
    async () => {
      const { recordGone } = await import('../../../packages/db/src/repo/record-gone');
      const { goneSentence } = await import('../../../packages/db/src/refusal');
      const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
      revokeGrantById.mockRejectedValueOnce(recordGone(`revokeGrantById: grant ${U} does not exist or is already revoked`, 'grant'));
      const { setCapabilityGrantAction } = await import('../src/app/admin/users/actions');
      const fd = new FormData();
      fd.set('personId', 'person-2');
      fd.set('grantId', U);
      fd.set('granted', 'false');
      fd.set('reason', 'No longer needed.');
      fd.set('confirmName', (await import('../../../packages/auth/src/capabilities')).capabilityTitle('void_expense'));
      const to = await expectRedirectTo(() => setCapabilityGrantAction(fd));
      expect(errorOf(to)).toBe(goneSentence('grant'));
    },
    30000,
  );

  it(
    '(b) unlinkCredential: a credential already revoked renders goneSentence(\'sign-in account\')',
    async () => {
      const { recordGone } = await import('../../../packages/db/src/repo/record-gone');
      const { goneSentence } = await import('../../../packages/db/src/refusal');
      const U = '0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
      unlinkCredential.mockRejectedValueOnce(recordGone(`revokeCredential: credential ${U} does not exist or is already revoked`, 'sign-in account'));
      const { unlinkCredentialAction } = await import('../src/app/admin/users/actions');
      const fd = new FormData();
      fd.set('personId', 'person-2');
      fd.set('credentialId', U);
      fd.set('reason', 'Retired.');
      fd.set('confirmName', 'The Name');
      const to = await expectRedirectTo(() => unlinkCredentialAction(fd));
      expect(errorOf(to)).toBe(goneSentence('sign-in account'));
    },
    30000,
  );
});

// ===========================================================================================
// K1 (⛔ green now) — one row per file: a non-presentable error still hits its kept local branch.
// ===========================================================================================

describe('K1 (⛔) — a non-presentable error still hits its kept local branch, unchanged', () => {
  it(
    'admin/users — a { code: "23505", constraint: "person_credentials_external_id_unique" } error renders the mapped sentence',
    async () => {
      linkFirebaseCredential.mockRejectedValueOnce(
        pgError(
          'duplicate key value violates unique constraint "person_credentials_external_id_unique"',
          '23505',
          'person_credentials_external_id_unique',
        ),
      );
      const { linkFirebaseAction } = await import('../src/app/admin/users/actions');
      const fd = new FormData();
      fd.set('personId', 'person-2');
      fd.set('uid', 'firebase-uid-1');
      const to = await expectRedirectTo(() => linkFirebaseAction(fd));
      expect(errorOf(to)).toBe('That Firebase account is already linked to somebody. Unlink it there first, then link it here.');
    },
    30000,
  );

  it(
    'access-defaults — a plain Error matching /belongs to a different store/ renders the raw text itself',
    async () => {
      setPositionDefault.mockRejectedValueOnce(new Error('setPositionDefault: this position belongs to a different store'));
      const { toggleDefaultAction } = await import('../src/app/admin/access-defaults/actions');
      const fd = new FormData();
      fd.set('storeId', 'store-1');
      fd.set('positionId', 'pos-1');
      fd.set('capability', 'record_sale');
      fd.set('on', 'true');
      const to = await expectRedirectTo(() => toggleDefaultAction(fd));
      expect(errorOf(to)).toBe('setPositionDefault: this position belongs to a different store');
    },
    30000,
  );
});
