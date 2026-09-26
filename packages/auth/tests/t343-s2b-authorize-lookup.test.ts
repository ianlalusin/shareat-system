/**
 * T-343 S2b — L1-L6: `authorize()`'s row-5 store-scoped lookup (DEF-430).
 * docs/tasks/343-def-417-human-readable-refusals.md §S2b.
 *
 * `@shareat/db` is mocked entirely (`vi.mock`), mirroring `t343-authorize-lookups.test.ts:34-70` —
 * a UNIT test of `authorize()`'s own control flow, never a real database. Real-DB coverage of the
 * same row lives in the new describes added to `t341-position-grants-per-store.test.ts` (I1-I6b)
 * and `authorize.test.ts` (I7).
 *
 * ⛔ Was red before the builder: `accessRepo.positionGrantsElsewhere` did not exist, and
 * `authorize.ts`'s row 5 made no lookup at all — every leg below failed for the reason the §S2b
 * table states.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const activeRoleForPerson = vi.fn();
const personHasActiveGrant = vi.fn();
const storeBelongsToOrg = vi.fn();
const personHasStoreScope = vi.fn();
const personCoversWholeOrg = vi.fn();
const grantsForPerson = vi.fn();
const positionGrantsElsewhere = vi.fn();
const getById = vi.fn();
const identityOf = vi.fn();
const warn = vi.fn();

vi.mock('@shareat/db', () => ({
  accessRepo: {
    activeRoleForPerson: (...args: unknown[]) => activeRoleForPerson(...args),
    personHasActiveGrant: (...args: unknown[]) => personHasActiveGrant(...args),
    storeBelongsToOrg: (...args: unknown[]) => storeBelongsToOrg(...args),
    personHasStoreScope: (...args: unknown[]) => personHasStoreScope(...args),
    personCoversWholeOrg: (...args: unknown[]) => personCoversWholeOrg(...args),
    grantsForPerson: (...args: unknown[]) => grantsForPerson(...args),
    positionGrantsElsewhere: (...args: unknown[]) => positionGrantsElsewhere(...args),
  },
  organizationsRepo: { identityOf: (...args: unknown[]) => identityOf(...args) },
  storesRepo: { getById: (...args: unknown[]) => getById(...args) },
}));

vi.mock('@shareat/core/logger', () => ({
  logger: { warn: (...args: unknown[]) => warn(...args), error: vi.fn(), info: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of [
    activeRoleForPerson,
    personHasActiveGrant,
    storeBelongsToOrg,
    personHasStoreScope,
    personCoversWholeOrg,
    grantsForPerson,
    positionGrantsElsewhere,
    getById,
    identityOf,
    warn,
  ]) {
    fn.mockClear();
  }
});

const actor = { personId: 'person-1', orgId: 'org-1' };
// See `t343-authorize-lookups.test.ts`'s own comment: the mock `tx` needs `.transaction` because
// every refusal-branch lookup (including the new one) runs inside `savepointLookup`.
const tx = { transaction: (fn: (t: unknown) => unknown) => fn(tx) } as never;

const SMK2 = { name: 'SmokeStore Two', code: 'SMK2' };
const ROLE_MAY_NOT_STAFF_SUBMIT = "Your role (Staff) can't submit a sales day. Ask an admin if you need to.";
const J1_SENTENCE =
  "You can't submit a sales day at SmokeStore Two (SMK2) — the Cashier job that lets you is at SmokeStore (SMK). Ask an admin if you need to do it here too.";

describe('L1 — row 5, store-scoped, job elsewhere found: userMessage is the DEF-430 sentence', () => {
  it("userMessage === J1's sentence; message stays authorize: role 'staff' may not 'submit_sales_day'", async () => {
    const { authorize, AuthorizationError } = await import('../src/authorize');
    activeRoleForPerson.mockResolvedValue({ role: 'staff' });
    personHasActiveGrant.mockResolvedValue(false);
    positionGrantsElsewhere.mockResolvedValue([{ positionName: 'Cashier', storeName: 'SmokeStore', storeCode: 'SMK' }]);
    getById.mockResolvedValue(SMK2);

    let caught: unknown;
    try {
      await authorize(tx, actor, 'submit_sales_day', { storeId: 'store-smk2' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as Error).message).toBe("authorize: role 'staff' may not 'submit_sales_day'");
    expect((caught as { userMessage?: string }).userMessage).toBe(J1_SENTENCE);
  });
});

describe('L2 — positionGrantsElsewhere is called once with the right args', () => {
  it('{ personId, orgId: actor.orgId, capability, excludingStoreId: storeId }', async () => {
    const { authorize } = await import('../src/authorize');
    activeRoleForPerson.mockResolvedValue({ role: 'staff' });
    personHasActiveGrant.mockResolvedValue(false);
    positionGrantsElsewhere.mockResolvedValue([]);

    await authorize(tx, actor, 'submit_sales_day', { storeId: 'store-smk2' }).catch(() => undefined);

    expect(positionGrantsElsewhere).toHaveBeenCalledTimes(1);
    expect(positionGrantsElsewhere).toHaveBeenCalledWith(tx, {
      personId: actor.personId,
      orgId: actor.orgId,
      capability: 'submit_sales_day',
      excludingStoreId: 'store-smk2',
    });
  });
});

describe('L3 (⛔) — empty lookup result falls back to roleMayNot; getById never called', () => {
  it('green before and after', async () => {
    const { authorize, AuthorizationError } = await import('../src/authorize');
    activeRoleForPerson.mockResolvedValue({ role: 'staff' });
    personHasActiveGrant.mockResolvedValue(false);
    positionGrantsElsewhere.mockResolvedValue([]);

    let caught: unknown;
    try {
      await authorize(tx, actor, 'submit_sales_day', { storeId: 'store-smk2' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as { userMessage?: string }).userMessage).toBe(ROLE_MAY_NOT_STAFF_SUBMIT);
    expect(getById).not.toHaveBeenCalled();
  });
});

describe('L4 — the lookup rejects: still AuthorizationError, roleMayNot text, logger.warn called once', () => {
  it('warn is called once (today: 0 calls — no lookup exists)', async () => {
    const { authorize, AuthorizationError } = await import('../src/authorize');
    activeRoleForPerson.mockResolvedValue({ role: 'staff' });
    personHasActiveGrant.mockResolvedValue(false);
    positionGrantsElsewhere.mockRejectedValue(new Error('connection reset'));

    let caught: unknown;
    try {
      await authorize(tx, actor, 'submit_sales_day', { storeId: 'store-smk2' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AuthorizationError);
    expect((caught as { userMessage?: string }).userMessage).toBe(ROLE_MAY_NOT_STAFF_SUBMIT);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('L5 (⛔) — the lookup never fires outside row 5’s store-scoped-and-refused branch', () => {
  it('success path never calls positionGrantsElsewhere/getById, even if they would throw', async () => {
    const { authorize } = await import('../src/authorize');
    activeRoleForPerson.mockResolvedValue({ role: 'admin' });
    personHasActiveGrant.mockResolvedValue(false);
    storeBelongsToOrg.mockResolvedValue(true);
    personHasStoreScope.mockResolvedValue(true);
    positionGrantsElsewhere.mockImplementation(() => {
      throw new Error('must not be called on the success path');
    });
    getById.mockImplementation(() => {
      throw new Error('must not be called on the success path');
    });

    await expect(authorize(tx, actor, 'void_expense', { storeId: 'store-1' })).resolves.toBeUndefined();
    expect(positionGrantsElsewhere).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
  });

  it('an org-scoped row-5 refusal (close_period, staff) never calls positionGrantsElsewhere', async () => {
    const { authorize } = await import('../src/authorize');
    activeRoleForPerson.mockResolvedValue({ role: 'staff' });
    personHasActiveGrant.mockResolvedValue(false);

    await authorize(tx, actor, 'close_period', {}).catch(() => undefined);
    expect(positionGrantsElsewhere).not.toHaveBeenCalled();
  });

  it('a store-scoped refusal with no storeId never calls positionGrantsElsewhere', async () => {
    const { authorize } = await import('../src/authorize');
    activeRoleForPerson.mockResolvedValue({ role: 'staff' });
    personHasActiveGrant.mockResolvedValue(false);

    await authorize(tx, actor, 'submit_sales_day', {}).catch(() => undefined);
    expect(positionGrantsElsewhere).not.toHaveBeenCalled();
  });
});

// --- L6: static census, mirrors `t343-authorize-census.test.ts`'s style (T5) ---------------------

const authorizeSrc = readFileSync(join(import.meta.dirname, '..', 'src', 'authorize.ts'), 'utf8');

/** Same comment-stripping as `t343-authorize-census.test.ts` — copied, not imported (that file has
 *  no export and stays unedited). */
function codeOnly(src: string): string {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/** `code[openIndex]` must be the '(' opening a call's argument list; returns the balanced body text
 *  up to (not including) its matching ')'. */
function balancedCallBody(code: string, openIndex: number): string {
  let depth = 1;
  let i = openIndex + 1;
  for (; i < code.length && depth > 0; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') depth--;
  }
  return code.slice(openIndex + 1, i - 1);
}

describe('L6 — census: row 5 carries both calls; positionGrantsElsewhere never runs outside a savepoint', () => {
  const code = codeOnly(authorizeSrc);

  it("the row-5 AuthorizationError's third argument contains jobIsElsewhere( AND roleMayNot(", () => {
    const marker = "may not '${capability}'"; // unique to row 5's raw message
    const markerIdx = code.indexOf(marker);
    expect(markerIdx, "row 5's raw message must still be present").toBeGreaterThan(-1);
    const callIdx = code.lastIndexOf('new AuthorizationError(', markerIdx);
    expect(callIdx, 'row 5 must still throw via new AuthorizationError(').toBeGreaterThan(-1);
    const openIndex = callIdx + 'new AuthorizationError'.length;
    const args = balancedCallBody(code, openIndex);
    expect(args).toContain('jobIsElsewhere(');
    expect(args).toContain('roleMayNot(');
  });

  it('positionGrantsElsewhere( occurs only inside a savepointLookup( call', () => {
    const total = (code.match(/positionGrantsElsewhere\(/g) ?? []).length;
    expect(total, 'sanity: positionGrantsElsewhere must be called somewhere').toBeGreaterThan(0);

    let insideCount = 0;
    const savepointRe = /savepointLookup\(/g;
    let m: RegExpExecArray | null;
    while ((m = savepointRe.exec(code))) {
      const openIndex = m.index + 'savepointLookup'.length;
      const body = balancedCallBody(code, openIndex);
      insideCount += (body.match(/positionGrantsElsewhere\(/g) ?? []).length;
    }
    expect(insideCount).toBe(total);
  });
});
