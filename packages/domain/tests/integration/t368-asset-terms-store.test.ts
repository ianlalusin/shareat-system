import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-368 S3 (DEF-436 asset terms through the domain; DEF-442 no asset at a deactivated store) — `docs/tasks/368-periods-depreciation.md` §S3,
 * legs T1-T7 and T9. T8 (capitalizeFromExpense at an inactive store is unchanged) is in `fixed-assets.test.ts` next to the seam it guards.
 *
 * ⛔ TESTER. Red until the builder adds `updateAssetTerms` (`packages/domain/src/fixed-assets/terms.ts`, exported from the domain index),
 * the store check in `runCreateAsset`, and a `FOR UPDATE` first read on both `updateAssetTerms` and `postPeriodsFor`.
 * ASSUMED input shape (the spec does not give one): the form's own — name, category, usefulLifeMonths (a raw STRING, the parse moves
 * into the domain), interval, salvageValue (string | null), notes (string | null). Say if the builder's differs and I will follow it.
 * The DB trigger (migration 0174) is the backstop and is NOT what these legs assert: they want the domain's sentence.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, fixedAssetsRepo, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import {
  createAsset,
  disposeAsset,
  depreciationDrift,
  runDepreciationAsSystem,
  setStoreOpeningDate,
  // ⛔ Not yet exported by `@shareat/domain` — see header.
  setAssetInService,
  reverseEntry,
  depreciateAsset,
  bookMissedMonth,
  missedMonths,
} from '@shareat/domain';
import { sql as dsql } from 'drizzle-orm';
import * as domain from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
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

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** Manila "today", read from Postgres so this file never goes stale (DEF-283). */
async function manilaTodayRaw(): Promise<string> {
  const [row] = await sql<{ today: string }[]>`select (now() at time zone 'Asia/Manila')::date::text as today`;
  return row!.today;
}
function monthEnd(year: number, month1based: number): string {
  return new Date(Date.UTC(year, month1based, 0)).toISOString().slice(0, 10);
}

async function insertPeriod(
  orgId: string,
  startsOn: string,
  endsOn: string,
  opts: { status?: 'open' | 'closed' | 'locked'; closedAt?: string; closedBy?: string } = {},
): Promise<void> {
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
    values (${orgId}, ${startsOn}, ${endsOn}, ${opts.status ?? 'open'}, ${opts.closedAt ?? null}, ${opts.closedBy ?? null})`;
}
async function insertMonths(
  orgId: string,
  startYear: number,
  startMonth: number,
  endYear: number,
  endMonth: number,
  opts: { status?: 'open' | 'closed' | 'locked'; closedAt?: string; closedBy?: string } = {},
): Promise<void> {
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    await insertPeriod(orgId, `${y}-${String(m).padStart(2, '0')}-01`, monthEnd(y, m), opts);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

interface OrgFixture {
  orgId: string;
  storeId: string;
  adminId: string;
  admin: Actor;
  superAdmin: Actor;
  manager: Actor;
  staff: Actor;
}

/** One org, one store (opening_date as given — NULL by default, so a fresh asset there is HELD),
 *  chart of accounts, and four people. */
async function rolesFixture(hint: string, openingDate: string | null = null): Promise<OrgFixture> {
  const code = uid(`t346is-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('s')}, 'Store', ${openingDate}) returning id`;
  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    return p!.id;
  };
  const adminId = await person('Admin', 'admin');
  const superAdminId = await person('Super Admin', 'super_admin');
  const managerId = await person('Manager', 'manager');
  const staffId = await person('Staff', 'staff');
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${store!.id})`;
  return {
    orgId,
    storeId: store!.id,
    adminId,
    admin: actor(orgId, adminId),
    superAdmin: actor(orgId, superAdminId),
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
  };
}

/** Spec §4's own base terms: cost 24,000, 24 months, monthly, salvage 0, acquired 2026-03-15. */
async function makeAsset(f: OrgFixture, over: Record<string, unknown> = {}): Promise<string> {
  const { id } = await withOrgPrincipal(f.orgId, (tx) =>
    createAsset(tx, f.admin, {
      storeId: f.storeId,
      name: 'Chiller',
      category: 'equipment',
      acquiredOn: '2026-03-15',
      cost: '24000.00',
      salvageValue: '0',
      usefulLifeMonths: 24,
      interval: 'monthly',
      ...over,
    } as Parameters<typeof createAsset>[2]),
  );
  return id;
}

async function inServiceOf(assetId: string): Promise<{ source: string | null; on: string | null }> {
  const [row] = await sql<{ in_service_source: string | null; in_service_on: string | null }[]>`
    select in_service_source, in_service_on::text as in_service_on from fixed_assets where id = ${assetId}`;
  return { source: row?.in_service_source ?? null, on: row?.in_service_on ?? null };
}

const setStoreOpening = (
  actorArg: Actor,
  storeId: string,
  input: { openingDate: string | null; confirm?: boolean },
) =>
  withPlan(input.confirm, (confirmedPlan) =>
    withOrgPrincipal(actorArg.orgId, (tx) =>
      setStoreOpeningDate(tx, actorArg, storeId, { openingDate: input.openingDate, ...(confirmedPlan ? { confirmedPlan } : {}) } as never),
    ),
  );

const setInService = (
  actorArg: Actor,
  assetId: string,
  input: { mode: 'acquired' | 'store_opening' | 'set'; inServiceOn?: string; reason: string; confirm?: boolean },
) => {
  const { confirm, ...rest } = input;
  return withPlan(confirm, (confirmedPlan) =>
    withOrgPrincipal(actorArg.orgId, (tx) => setAssetInService(tx, actorArg, assetId, { ...rest, ...(confirmedPlan ? { confirmedPlan } : {}) } as never)),
  );
};

/**
 * T-368 S2 (DEF-441): a reversal confirm is pinned to the exact entry set it showed. `confirm: true` here means the REAL
 * two-step a person does: call without a token, take `planToken` off the refusal, call again with it as `confirmedPlan`.
 * If the first call does not refuse with a token (nothing to reverse) its result is returned as is. Red until S2 lands:
 * today the first call refuses with no `planToken` and the helper rethrows it.
 */
async function withPlan<T>(confirm: boolean | undefined, run: (confirmedPlan?: string) => Promise<T>): Promise<T> {
  if (!confirm) return run();
  try {
    return await run();
  } catch (err) {
    const token = (err as { planToken?: string }).planToken;
    if (!token) throw err;
    return run(token);
  }
}

async function runThrough(orgId: string, through: string) {
  return runDepreciationAsSystem(orgId, { through });
}

async function entryCountForKey(orgId: string, idempotencyKey: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_entries where org_id = ${orgId} and idempotency_key = ${idempotencyKey}`;
  return row!.n;
}
async function entryRow(orgId: string, idempotencyKey: string) {
  const [row] = await sql<{ id: string; entry_date: string; memo: string; status: string }[]>`
    select id, entry_date::text as entry_date, memo, status from journal_entries
    where org_id = ${orgId} and idempotency_key = ${idempotencyKey}`;
  return row;
}
async function reversalOf(orgId: string, originalEntryId: string) {
  const [row] = await sql<{ entry_date: string; memo: string }[]>`
    select entry_date::text as entry_date, memo from journal_entries
    where org_id = ${orgId} and reversal_of_entry_id = ${originalEntryId}`;
  return row;
}
async function linesFor(entryId: string) {
  return sql<{ code: string; debit: string; credit: string }[]>`
    select a.code, jl.debit, jl.credit from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by jl.line_no`;
}
async function accountLineCount(orgId: string, assetId: string, code: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.source_id = ${assetId} and a.code = ${code}`;
  return row!.n;
}


// =================================================================================================
// Fixtures. Store opens 2026-01-01 (assets are never HELD); periods open 2026-03..2026-12; asset = 24,000 / 24 months / monthly /
// salvage 0 = 1,000.00 a month, acquired 2026-03-15 (first month 2026-03). The input shape of `updateAssetTerms` is the form's:
// every field a raw string (the life PARSE moves into the domain), `salvageValue`/`notes` nullable.
// =================================================================================================

type TermsInput = { name: string; category: string; usefulLifeMonths: string; interval: string; salvageValue: string | null; notes: string | null };
type UpdateAssetTerms = (tx: Tx, actor: Actor, assetId: string, input: TermsInput) => Promise<unknown>;
const updateTerms = async (f: OrgFixture, who: Actor, assetId: string, input: TermsInput) => {
  const fn = (domain as unknown as { updateAssetTerms?: UpdateAssetTerms }).updateAssetTerms;
  if (typeof fn !== 'function') throw new Error('updateAssetTerms is not exported from @shareat/domain (packages/domain/src/fixed-assets/terms.ts does not exist yet)');
  return withOrgPrincipal(f.orgId, (tx) => fn(tx, who, assetId, input));
};
async function termsOf(assetId: string): Promise<TermsInput & { needsReview: boolean }> {
  const [r] = await sql<{ name: string; category: string; u: number; i: string; s: string | null; n: string | null; nr: boolean }[]>`
    select name, category, useful_life_months as u, "interval" as i, salvage_value::text as s, notes as n, needs_review as nr from fixed_assets where id = ${assetId}`;
  return { name: r!.name, category: r!.category, usefulLifeMonths: String(r!.u), interval: r!.i, salvageValue: r!.s, notes: r!.n, needsReview: r!.nr };
}
const sameTerms = (t: Awaited<ReturnType<typeof termsOf>>): TermsInput => ({
  name: t.name, category: t.category, usefulLifeMonths: t.usefulLifeMonths, interval: t.interval, salvageValue: t.salvageValue, notes: t.notes,
});
async function termsFixture(hint: string, through?: string) {
  const f = await rolesFixture(hint, '2026-01-01');
  await insertMonths(f.orgId, 2026, 3, 2026, 12);
  const assetId = await makeAsset(f);
  if (through) await runThrough(f.orgId, through);
  return { f, assetId };
}
const USER_SENTENCE = (first: string, last: string) =>
  `Chiller has already been depreciated (${first} to ${last}), so its useful life, interval and salvage value can no longer be changed. Name, category and notes can still be edited.`;
async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; name: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string; name?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, name: e.name ?? '' };
  }
  throw new Error(`NOT REFUSED — ${what} succeeded instead (the defect this leg targets)`);
}

describe('T1 — terms are immutable once a month is posted (DEF-436), refused by the DOMAIN with a sentence', () => {
  it('2026-03 posted, life 24 -> 36: refused with the exact user sentence (no id, not the trigger text); the row is unchanged', async () => {
    const { f, assetId } = await termsFixture('t1', '2026-03');
    const before = await termsOf(assetId);
    const refused = await rejection(updateTerms(f, f.admin, assetId, { ...sameTerms(before), usefulLifeMonths: '36' }), 'a life change on a depreciated asset');
    expect(refused.userMessage, `raw text leaked: ${refused.message}`).toBe(USER_SENTENCE('2026-03', '2026-03'));
    expect(refused.message, 'the developer message is the domain one, not the S0 trigger text').toMatch(/^updateAssetTerms: Chiller has depreciation posted for 2026-03–2026-03; its useful life, interval and salvage value can no longer change/);
    expect(await termsOf(assetId)).toEqual(before);
  });

  it('three months posted: the sentence names the first and the last period; interval and salvage changes are refused the same way', async () => {
    const { f, assetId } = await termsFixture('t1b', '2026-05');
    const before = await termsOf(assetId);
    for (const change of [{ interval: 'quarterly' }, { salvageValue: '500.00' }] as const) {
      const refused = await rejection(updateTerms(f, f.admin, assetId, { ...sameTerms(before), ...change }), `a ${Object.keys(change)[0]} change`);
      expect(refused.userMessage).toBe(USER_SENTENCE('2026-03', '2026-05'));
    }
    expect(await termsOf(assetId)).toEqual(before);
  });
});

describe('T2/T3 (controls) — what is still editable', () => {
  it('T2: only name/category/notes on a depreciated asset: written, and needsReview is cleared', async () => {
    const { f, assetId } = await termsFixture('t2', '2026-03');
    await sql`update fixed_assets set needs_review = true where id = ${assetId}`;
    const before = await termsOf(assetId);
    await updateTerms(f, f.admin, assetId, { ...sameTerms(before), name: 'Walk-in Chiller', category: 'equipment', notes: 'reviewed' });
    const after = await termsOf(assetId);
    expect(after.name).toBe('Walk-in Chiller');
    expect(after.notes).toBe('reviewed');
    expect(after.usefulLifeMonths).toBe(before.usefulLifeMonths);
    expect(after.needsReview).toBe(false);
  });

  it('T3: an asset with NOTHING posted: the life change is written', async () => {
    const { f, assetId } = await termsFixture('t3');
    const before = await termsOf(assetId);
    await updateTerms(f, f.admin, assetId, { ...sameTerms(before), usefulLifeMonths: '36' });
    expect((await termsOf(assetId)).usefulLifeMonths).toBe('36');
  });

  it('an asset whose only entry was REVERSED counts as nothing posted: the life change is written', async () => {
    const { f, assetId } = await termsFixture('t3b', '2026-03');
    const e = await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-03`);
    await withOrgPrincipal(f.orgId, (tx) => reverseEntry(tx, { entryId: e!.id, reason: 'undo', reversedBy: f.adminId }));
    const before = await termsOf(assetId);
    await updateTerms(f, f.admin, assetId, { ...sameTerms(before), usefulLifeMonths: '36' });
    expect((await termsOf(assetId)).usefulLifeMonths).toBe('36');
  });
});

describe('T4/T5 — authorize comes before parse', () => {
  it('T4 (✗ fires): staff with valid input get AuthorizationError; nothing is written', async () => {
    const { f, assetId } = await termsFixture('t4');
    const before = await termsOf(assetId);
    const refused = await rejection(updateTerms(f, f.staff, assetId, { ...sameTerms(before), usefulLifeMonths: '36' }), 'staff changing terms');
    expect(refused.name).toBe('AuthorizationError');
    expect(await termsOf(assetId)).toEqual(before);
  });

  it('T5: staff with usefulLifeMonths "abc" get the SAME refusal as T4 (the parse never ran), while the admin gets the life sentence', async () => {
    const { f, assetId } = await termsFixture('t5');
    const before = await termsOf(assetId);
    const valid = await rejection(updateTerms(f, f.staff, assetId, { ...sameTerms(before), usefulLifeMonths: '36' }), 'staff, valid');
    const bad = await rejection(updateTerms(f, f.staff, assetId, { ...sameTerms(before), usefulLifeMonths: 'abc' }), 'staff, bad life');
    expect(bad.name).toBe('AuthorizationError');
    expect(bad.message).toBe(valid.message);
    const admin = await rejection(updateTerms(f, f.admin, assetId, { ...sameTerms(before), usefulLifeMonths: 'abc' }), 'admin, bad life');
    expect(admin.userMessage).toBe('The useful life must be a whole number of months, 1 or more.');
    expect(await termsOf(assetId)).toEqual(before);
  });
});

describe('T6/T7 — no asset at a deactivated store (DEF-442)', () => {
  const input = (f: OrgFixture) =>
    ({ storeId: f.storeId, name: 'Fryer', category: 'equipment', acquiredOn: '2026-03-15', cost: '12000.00', salvageValue: '0', usefulLifeMonths: 12, interval: 'monthly' }) as Parameters<typeof createAsset>[2];
  const assetRows = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from fixed_assets where org_id = ${orgId}`)[0]!.n;

  it('T6: createAsset at a deactivated store refuses "Store is deactivated. An asset cannot be added at a store that is no longer active."; no asset row', async () => {
    const f = await rolesFixture('t6', '2026-01-01');
    await sql`update stores set is_active = false where id = ${f.storeId}`;
    const refused = await rejection(withOrgPrincipal(f.orgId, (tx) => createAsset(tx, f.admin, input(f))), 'creating an asset at a deactivated store');
    expect(refused.userMessage, `raw text leaked: ${refused.message}`).toBe('Store is deactivated. An asset cannot be added at a store that is no longer active.');
    expect(refused.message).toMatch(/^createAsset: store .* is deactivated/);
    expect(await assetRows(f.orgId)).toBe(0);
  });

  it('T7 (control): the same store re-activated: created', async () => {
    const f = await rolesFixture('t7', '2026-01-01');
    await sql`update stores set is_active = false where id = ${f.storeId}`;
    await rejection(withOrgPrincipal(f.orgId, (tx) => createAsset(tx, f.admin, input(f))), 'creating an asset at a deactivated store');
    await sql`update stores set is_active = true where id = ${f.storeId}`;
    const made = await withOrgPrincipal(f.orgId, (tx) => createAsset(tx, f.admin, input(f)));
    expect(made.id).toBeTruthy();
    expect(await assetRows(f.orgId)).toBe(1);
  });

  it('a store id that does not exist is refused as a missing store, not a raw FK error', async () => {
    const f = await rolesFixture('t6b', '2026-01-01');
    const refused = await rejection(
      withOrgPrincipal(f.orgId, (tx) => createAsset(tx, f.admin, { ...input(f), storeId: '00000000-0000-7000-8000-000000000000' })),
      'creating an asset at a missing store',
    );
    expect(refused.message).not.toMatch(/foreign key|violates/i);
    expect(await assetRows(f.orgId)).toBe(0);
  });
});

describe('T9 — a terms change and a depreciation run on the same asset serialise (race, two connections)', () => {
  const settled = (p: Promise<unknown>) => {
    const s = { done: false };
    p.then(() => (s.done = true), () => (s.done = true));
    return s;
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('A changes the life (24 -> 36, nothing posted) and holds its tx open; B runs depreciateAsset through 2026-03: B blocks until A commits, then posts at the NEW terms (666.66 = floor(2,400,000c / 36); the 24c remainder lands on the LAST month)', async () => {
    const { f, assetId } = await termsFixture('t9a');
    const before = await termsOf(assetId);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let aWrote!: () => void;
    const wrote = new Promise<void>((r) => (aWrote = r));
    const a = withOrgPrincipal(f.orgId, async (tx) => {
      await (domain as unknown as { updateAssetTerms: UpdateAssetTerms }).updateAssetTerms(tx, f.admin, assetId, { ...sameTerms(before), usefulLifeMonths: '36' });
      aWrote();
      await gate;
    });
    await Promise.race([wrote, a]); // if the change itself throws (no such function yet), fail here instead of hanging on the gate
    const b = withOrgPrincipal(f.orgId, (tx) => depreciateAsset(tx, f.admin, { assetId, through: '2026-03' }));
    const bState = settled(b);
    await wait(800);
    const waited = !bState.done;
    release();
    await a;
    await b;
    expect(waited, 'the run did not wait for the terms change (no FOR UPDATE on one side)').toBe(true);
    const e = await entryRow(f.orgId, `asset:${assetId}:depreciation:2026-03`);
    expect(e?.status).toBe('posted');
    // 24,000.00 / 36 = 66,666.67c -> per-month floor 666.66; the 0.24 remainder is the 36th month's, so the first (2026-03) charge is 666.66 (old 24-month terms would be 1,000.00).
    expect((await linesFor(e!.id)).find((l) => l.code === '6700')?.debit, 'posted at the OLD terms while the new ones were written (expected the NEW 36-month figure)').toBe('666.66');
  });

  it('B runs depreciateAsset first and holds its tx open; A then tries to change the life: A waits, then is refused with the DOMAIN sentence, never the raw trigger error', async () => {
    const { f, assetId } = await termsFixture('t9b');
    const before = await termsOf(assetId);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let bPosted!: () => void;
    const posted = new Promise<void>((r) => (bPosted = r));
    const b = withOrgPrincipal(f.orgId, async (tx) => {
      await depreciateAsset(tx, f.admin, { assetId, through: '2026-03' });
      bPosted();
      await gate;
    });
    await posted;
    const a = rejection(updateTerms(f, f.admin, assetId, { ...sameTerms(before), usefulLifeMonths: '36' }), 'a terms change racing a run');
    const aState = settled(a);
    await wait(800);
    const waited = !aState.done;
    release();
    await b;
    const refused = await a;
    expect(waited, 'the terms change did not wait for the run').toBe(true);
    expect(refused.userMessage, `a raw error reached the person: ${refused.message}`).toBe(USER_SENTENCE('2026-03', '2026-03'));
    expect(refused.message).not.toMatch(/fixed_assets: .* already has depreciation posted/);
    expect((await termsOf(assetId)).usefulLifeMonths).toBe('24');
  });
});

// =================================================================================================
// T10 — updateAssetTerms refuses raw form values the domain used to leave to the DB (interval, category, salvage vs cost): each with
// the user sentence, and nothing written (the row is unchanged).
// =================================================================================================

describe('T10 — interval, category and salvage are refused by NAME with a sentence, writing nothing', () => {
  it('an interval outside monthly/quarterly/semiannual/annually: the interval sentence; the row is unchanged', async () => {
    const { f, assetId } = await termsFixture('t10a');
    const before = await termsOf(assetId);
    for (const bad of ['weekly', 'Monthly', '', 'semi-annual']) {
      const refused = await rejection(updateTerms(f, f.admin, assetId, { ...sameTerms(before), interval: bad }), `interval ${JSON.stringify(bad)}`);
      expect(refused.userMessage, `raw text leaked: ${refused.message}`).toBe('Choose a depreciation interval from the list: monthly, quarterly, semi-annual or annually.');
      expect(refused.message).not.toMatch(/violates|check constraint|invalid input value/i);
    }
    expect(await termsOf(assetId)).toEqual(before);
  });

  it('a category outside ASSET_CATEGORIES: the category sentence; the row is unchanged', async () => {
    const { f, assetId } = await termsFixture('t10b');
    const before = await termsOf(assetId);
    for (const bad of ['spaceship', 'Equipment', '']) {
      const refused = await rejection(updateTerms(f, f.admin, assetId, { ...sameTerms(before), category: bad }), `category ${JSON.stringify(bad)}`);
      expect(refused.userMessage, `raw text leaked: ${refused.message}`).toBe('Choose an asset category from the list.');
      expect(refused.message).not.toMatch(/violates|check constraint|invalid input value/i);
    }
    expect(await termsOf(assetId)).toEqual(before);
  });

  it('salvage at or above cost (24,000.00): salvage == cost and salvage > cost are refused with the salvage sentence; the row is unchanged', async () => {
    const { f, assetId } = await termsFixture('t10c');
    const before = await termsOf(assetId);
    for (const bad of ['24000.00', '24000', '30000.00']) {
      const refused = await rejection(updateTerms(f, f.admin, assetId, { ...sameTerms(before), salvageValue: bad }), `salvage ${bad}`);
      expect(refused.userMessage, `raw text leaked: ${refused.message}`).toBe("The salvage value must be below the asset's cost, or it never depreciates.");
      expect(refused.message).not.toMatch(/violates|check constraint/i);
    }
    expect(await termsOf(assetId)).toEqual(before);
  });

  it('a negative salvage ("-5"): the negative sentence, never the DB check text; the row is unchanged', async () => {
    const { f, assetId } = await termsFixture('t10n');
    const before = await termsOf(assetId);
    const refused = await rejection(updateTerms(f, f.admin, assetId, { ...sameTerms(before), salvageValue: '-5' }), 'a negative salvage');
    expect(refused.userMessage, ).toBe('The salvage value cannot be negative.');
    expect(refused.message).not.toMatch(/violates|check constraint/i);
    expect(await termsOf(assetId)).toEqual(before);
  });

  it('control: salvage = cost - 0.01 is accepted and written', async () => {
    const { f, assetId } = await termsFixture('t10d');
    const before = await termsOf(assetId);
    await updateTerms(f, f.admin, assetId, { ...sameTerms(before), salvageValue: '23999.99' });
    expect(Number((await termsOf(assetId)).salvageValue)).toBe(23999.99);
  });

  it('order: the interval and category checks fire BEFORE the asset is read — a non-existent id with a bad interval gets the interval sentence, a bad category the category sentence', async () => {
    const { f, assetId } = await termsFixture('t10e');
    const before = await termsOf(assetId);
    const ghost = '00000000-0000-7000-8000-000000000000';
    const badInterval = await rejection(updateTerms(f, f.admin, ghost, { ...sameTerms(before), interval: 'weekly' }), 'a bad interval on a missing asset');
    expect(badInterval.userMessage).toBe('Choose a depreciation interval from the list: monthly, quarterly, semi-annual or annually.');
    const badCategory = await rejection(updateTerms(f, f.admin, ghost, { ...sameTerms(before), category: 'spaceship' }), 'a bad category on a missing asset');
    expect(badCategory.userMessage).toBe('Choose an asset category from the list.');
  });
});
