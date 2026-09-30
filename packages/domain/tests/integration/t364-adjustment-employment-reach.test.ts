import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

/**
 * T-364 S2 (DEF-497) — `recordAdjustment` must authorise BEFORE the "no employment X" oracle can
 * be used to tell a real employmentId from a fake one, or a scoped-out/ungranted caller from one
 * with no right at all. `docs/tasks/364-def-496-497-authorise-first.md` §S2, legs A1-A9 (A10
 * skipped: it needs a full-module `@shareat/auth` mock to replace `authorize` for every caller in
 * this file, which is disproportionate for one optional, review-guarded leg — recorded as such in
 * the RED report, not asserted here). Harness copied from `attendance-adjustments.test.ts`
 * (`cleanDay`→unneeded here since every leg fails or succeeds at the gate before any punch/day
 * logic runs; `makeSession`, `minuteOf`, the staff-cashier grant shape `:251-277`).
 *
 * `O` = `EMPLOYMENT_OUT_OF_REACH`, written as a literal (it is the TARGET, bible row 233) — the
 * builder's own file is the only place that may change this string.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { createEmployment, recordAdjustment, seedAttendanceConfig, seedCanonicalPositions, toShiftDay } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
/** A9's owner-connection case, R8/A4 — no `set local role`, no RLS. */
function asOwner<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(fn);
}

const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

const DAY = toShiftDay(new Date(Date.now() - 24 * 3_600_000));
const minuteOf = (hour: number) => ((((hour - 5) % 24) + 24) % 24) * 60;

async function makeSession(personId: string, storeId: string): Promise<string> {
  const [cred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  const [s] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at)
    values (${uid('t')}, ${personId}, ${cred!.id}, 'pin', ${storeId}, now() + interval '12 hours')
    returning id`;
  return s!.id;
}

async function fixture(hint: string) {
  const code = uid(`t364-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string; code: string; name: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id, code, name`;
  const [store2] = await sql<{ id: string; code: string; name: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}-2`)}, ${`Store2 ${hint}`}) returning id, code, name`;

  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${admin!.id}, ${store!.id}, 'manual')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${admin!.id}, ${store2!.id}, 'manual')`;
  const adminActor = actorOf(orgId, admin!.id);

  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));

  const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;
  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, adminActor, { storeId: store!.id, personId: worker!.id, employmentStatus: 'regular', startedOn: '2026-01-05' }),
  );
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }));

  const [worker2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Store2 Worker') returning id`;
  const employment2 = await asOrg(orgId, (tx) =>
    createEmployment(tx, adminActor, { storeId: store2!.id, personId: worker2!.id, employmentStatus: 'regular', startedOn: '2026-01-05' }),
  );
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId: store2!.id, effectiveFrom: '2026-01-01' }));

  const sessionId = await makeSession(admin!.id, store!.id);

  // A1 — plain staff, no grant, scoped to the fixture store only. CAPABILITY-MATRIX: manage_attendance ✗ for staff.
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Floor Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${staff!.id}, ${store!.id}, 'manual')`;

  // A2/W2 — a manager scoped ONLY to the second store.
  const [otherManager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Other-Store Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${otherManager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${otherManager!.id}, ${store2!.id}, 'manual')`;

  // A3/A8 — staff with a manage_attendance grant scoped to the SECOND store (a manually-inserted
  // 'grant'-source row, not 'position'-source — see A3's own comment for why that matters).
  const [grantee] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Grant Elsewhere') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${grantee!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${grantee!.id}, ${store!.id}, 'manual')`;
  // grant_source = 'grant' — the ONLY source besides 'position' whose row may carry a store_id
  // (person_grants_store_shape_check, migration 0165): a "hold in their own right" override.
  await sql`insert into person_grants (person_id, grant_name, store_id, grant_source) values (${grantee!.id}, 'manage_attendance', ${store2!.id}, 'grant')`;

  return {
    orgId,
    storeId: store!.id,
    storeName: store!.name,
    storeCode: store!.code,
    storeId2: store2!.id,
    admin: adminActor,
    employment,
    employment2,
    sessionId,
    staff: actorOf(orgId, staff!.id),
    otherManager: actorOf(orgId, otherManager!.id),
    grantee: actorOf(orgId, grantee!.id),
    granteePersonId: grantee!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function adjustFor(f: Pick<Fixture, 'orgId' | 'sessionId'>, who: Actor, employmentId: string, extra: Record<string, unknown> = {}) {
  return asOrg(f.orgId, (tx) =>
    recordAdjustment(tx, who, {
      employmentId,
      shiftDay: DAY,
      sessionId: f.sessionId,
      kind: 'start_anchor',
      chosenAnchorMinute: minuteOf(14),
      ...extra,
    }),
  );
}

async function rejection(p: Promise<unknown>): Promise<AuthorizationError | Error> {
  try {
    await p;
  } catch (err) {
    return err as AuthorizationError | Error;
  }
  throw new Error('expected the call to reject');
}

async function adjustmentTotalForDay(f: Fixture): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from attendance_adjustments
    where org_id = ${f.orgId} and shift_day = ${DAY}`;
  return Number(row!.count);
}

async function adjustmentCountFor(f: Fixture, kind: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from attendance_adjustments
    where employment_id = ${f.employment.id} and shift_day = ${DAY} and kind = ${kind}
      and superseded_by_adjustment_id is null`;
  return Number(row!.count);
}

const O = 'That employment does not exist, or it is not at a store where you manage attendance.';

describe('A1 — oracle pair, role non-holder (staff, no grant)', () => {
  it('a real employment and a fake id both reject AuthorizationError, userMessage === O, and agree', async () => {
    const f = await fixture('a1');
    const errReal = await rejection(adjustFor(f, f.staff, f.employment.id));
    const errFake = await rejection(adjustFor(f, f.staff, randomUUID()));
    expect(errReal, String(errReal)).toBeInstanceOf(AuthorizationError);
    expect(errFake, String(errFake)).toBeInstanceOf(AuthorizationError);
    expect((errReal as AuthorizationError).capability).toBe('manage_attendance');
    expect((errFake as AuthorizationError).capability).toBe('manage_attendance');
    expect((errReal as AuthorizationError).userMessage).toBe(O);
    expect((errReal as AuthorizationError).userMessage).toBe((errFake as AuthorizationError).userMessage);
  });
});

describe('A2 — oracle pair, scoped-out holder (otherManager)', () => {
  // Split from the target assertion below (orchestrator RED-FIX, 2026-09-30): asserting BOTH
  // "names the store" and "userMessage === O" in one test is unsatisfiable once the fix lands — O
  // never names a store, by design (R6). This positive control proves the naming mechanism is
  // real by calling authorize() directly, independent of recordAdjustment/the gate; it is green
  // today AND after the fix, since authorize()'s own sentences are out of scope for this task.
  it('positive control: authorize() itself still names the store for this actor/store', async () => {
    const f = await fixture('a2-control');
    let named = '';
    try {
      await asOrg(f.orgId, (tx) => authorize(tx, f.otherManager, 'manage_attendance', { storeId: f.storeId, orgId: f.orgId }));
      throw new Error('expected authorize() to reject for this fixture');
    } catch (err) {
      named = (err as AuthorizationError).userMessage ?? (err as Error).message;
    }
    expect(
      named.includes(f.storeName) || named.includes(f.storeCode),
      `expected the fixture store's name/code (${f.storeName}/${f.storeCode}) in: ${named}`,
    ).toBe(true);
  });

  it('as A1; O never names the store, and the real/fake pair collapse to O', async () => {
    const f = await fixture('a2');
    const errReal = await rejection(adjustFor(f, f.otherManager, f.employment.id));
    const errFake = await rejection(adjustFor(f, f.otherManager, randomUUID()));
    expect(errReal).toBeInstanceOf(AuthorizationError);
    expect(errFake).toBeInstanceOf(AuthorizationError);
    expect((errReal as AuthorizationError).userMessage).toBe(O);
    expect((errFake as AuthorizationError).userMessage).toBe(O);
    // Mutant: recordAdjustment lets authorize()'s own store-naming sentence escape (drops the collapse to O) -> red.
    for (const e of [errReal, errFake]) {
      expect((e as AuthorizationError).userMessage).not.toContain(f.storeName);
      expect((e as AuthorizationError).userMessage).not.toContain(f.storeCode);
    }
  });
});

describe('A3 — grant elsewhere (a store-specific person_grants row that does not cover this store)', () => {
  it('uniformity only — see file header / RED report for why no store-name assertion is made here', async () => {
    const f = await fixture('a3');
    const errReal = await rejection(adjustFor(f, f.grantee, f.employment.id));
    // Recorded, not asserted: `positionGrantsElsewhere` (packages/db/src/repo/access.ts:956) only
    // matches `grant_source = 'position'` rows joined to `position_capability_defaults`; a plain
    // manually-inserted `person_grants` row is `grant_source` default (not 'position'), so this
    // shape reaches `roleMayNot` (no store name), never `jobIsElsewhere` — the task doc's own
    // fallback ("if this grant shape cannot reach jobIsElsewhere ... keep it as a uniformity leg
    // only") applies, so unlike A2 there is no store-name assertion below.
    // eslint-disable-next-line no-console
    console.log(`A3 (a) real-employment red today: ${(errReal as AuthorizationError).userMessage ?? errReal.message}`);

    const errFake = await rejection(adjustFor(f, f.grantee, randomUUID()));
    expect(errReal).toBeInstanceOf(AuthorizationError);
    expect(errFake).toBeInstanceOf(AuthorizationError);
    expect((errReal as AuthorizationError).userMessage).toBe(O);
    expect((errFake as AuthorizationError).userMessage).toBe(O);
  });
});

describe('A4 — cross-org, owner connection (no set-role / no RLS)', () => {
  it('a real employment in ANOTHER org and a fake id both collapse to O', async () => {
    const fA = await fixture('a4a');
    const fB = await fixture('a4b');
    const errReal = await rejection(
      asOwner((tx) =>
        recordAdjustment(tx, fA.admin, {
          employmentId: fB.employment.id,
          shiftDay: DAY,
          sessionId: fA.sessionId,
          kind: 'start_anchor',
          chosenAnchorMinute: minuteOf(14),
        }),
      ),
    );
    const errFake = await rejection(
      asOwner((tx) =>
        recordAdjustment(tx, fA.admin, {
          employmentId: randomUUID(),
          shiftDay: DAY,
          sessionId: fA.sessionId,
          kind: 'start_anchor',
          chosenAnchorMinute: minuteOf(14),
        }),
      ),
    );
    expect(errReal).toBeInstanceOf(AuthorizationError);
    expect(errFake).toBeInstanceOf(AuthorizationError);
    expect((errReal as AuthorizationError).userMessage).toBe(O);
    expect((errFake as AuthorizationError).userMessage).toBe(O);
  });
});

describe('A5 — positive control: the not-found refusal for a HOLDER', () => {
  it('a fake id still refuses uniformly, and nothing is written', async () => {
    const f = await fixture('a5');
    const fakeId = randomUUID();
    const countFake = async () => {
      const [row] = await sql<{ count: string }[]>`
        select count(*)::text as count from attendance_adjustments where employment_id = ${fakeId}`;
      return Number(row!.count);
    };
    const beforeFake = await countFake();
    const beforeTotal = await adjustmentTotalForDay(f);
    const err = await rejection(adjustFor(f, f.admin, fakeId));
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).userMessage).toBe(O);
    // Mutant: the gate refuses but the write runs first / regardless (insert moved before authorize) -> either count rises -> red.
    expect(await countFake()).toBe(beforeFake);
    expect(await adjustmentTotalForDay(f)).toBe(beforeTotal);
  });
});

describe('A6 — positive control: the gate still admits a real holder', () => {
  it('saves and returns the adjustment; count +1', async () => {
    const f = await fixture('a6');
    const before = await adjustmentCountFor(f, 'start_anchor');
    const { adjustment } = await adjustFor(f, f.admin, f.employment.id);
    expect(adjustment.employmentId).toBe(f.employment.id);
    expect(await adjustmentCountFor(f, 'start_anchor')).toBe(before + 1);
  });
});

describe('A7 — positive control: a holder still sees field sentences (T-352 D8, unchanged)', () => {
  it('blank chosenAnchorMinute — the DEF-471 sentence, not an authorization refusal', async () => {
    const f = await fixture('a7');
    const err = await rejection(adjustFor(f, f.admin, f.employment.id, { chosenAnchorMinute: '' }));
    expect((err as { userMessage?: string }).userMessage).toBe('The paid-from minute — enter a whole number of minutes (0 to 99999).');
  });
});

describe('A8 — positive control: a properly-scoped grant still admits', () => {
  it('A3\'s person, now ALSO granted at the fixture store, saves', async () => {
    const f = await fixture('a8');
    await sql`insert into person_grants (person_id, grant_name, store_id, grant_source) values (${f.granteePersonId}, 'manage_attendance', ${f.storeId}, 'grant')`;
    const before = await adjustmentCountFor(f, 'start_anchor');
    const { adjustment } = await adjustFor(f, f.grantee, f.employment.id);
    expect(adjustment.employmentId).toBe(f.employment.id);
    expect(await adjustmentCountFor(f, 'start_anchor')).toBe(before + 1);
  });
});

describe('A9 — the raw message keeps its diagnosis (for logs, never the screen)', () => {
  it("A1(b)'s not-found raw starts with 'recordAdjustment:'", async () => {
    const f = await fixture('a9-notfound');
    const err = await rejection(adjustFor(f, f.staff, randomUUID()));
    expect(err.message.startsWith('recordAdjustment:'), err.message).toBe(true);
  });

  it("A2(a)'s wrapped raw still contains authorize()'s own raw text", async () => {
    const f = await fixture('a9-scoped');
    let authorizeRaw = '';
    try {
      await asOrg(f.orgId, (tx) => authorize(tx, f.otherManager, 'manage_attendance', { storeId: f.storeId, orgId: f.orgId }));
      throw new Error('expected authorize() to reject for this fixture');
    } catch (err) {
      authorizeRaw = (err as Error).message;
    }
    expect(authorizeRaw).not.toBe('');

    const err = await rejection(adjustFor(f, f.otherManager, f.employment.id));
    expect(err.message.startsWith('recordAdjustment:'), err.message).toBe(true);
    expect(err.message).toContain(authorizeRaw);
  });
});
