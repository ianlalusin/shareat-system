import { config } from 'dotenv';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-382 S2 - the domain half of the guarded POS unlink. `docs/tasks/382-pos-store-unlink.md` section S2, tests U1-U12
 * (SPEC commit 6a05fd3, with the REV/AMEND rulings). TESTER, not BUILDER: no production code.
 *
 * ## Why most of this is red on HEAD (the reason, per test)
 * `unlinkStoreFromPos` does not exist (S2 builds it) and migration 0187 does not exist (S1 builds it). Every test that
 * unlinks goes through `unlink()` below, which calls `D.unlinkStoreFromPos`: on HEAD it fails with "is not a function".
 * That is a MISSING-FEATURE red, not a behavioural one. After S1 + S2 each leg fails (or passes) on the assertion named
 * in it. The two legs that already PASS on HEAD are U11's "never-linked typed day -> unlinked sentence" and "linked
 * typed day -> typed sentence" (REV-7's regression guards: they pin today's behaviour so the builder cannot break it)
 * and U12's control (a store linked once and never relinked still corrects).
 *
 * ## Pinned where the spec is silent (a question to the builder, never a test edit)
 *  - `unlinkStoreFromPos(tx, actor, { storeId, reason })` is exported from `@shareat/domain` (index already
 *    `export *`s `pos/store-link`), returns `{ linkId, importedDays }` and THROWS every refusal (a RefusalError);
 *  - R9a's refusal sentence on `postPosCorrection` AND `recheckPosDay` is the existing one:
 *    "{Store} isn't linked to a POS store, so its POS figures can't be read." (the spec says "the unlinked sentence");
 *  - R3's `{dates}` are `humanDate`s joined by ", "; the test asserts each date appears and the frame word for word;
 *  - the audit row is found by `action = 'unlink_store_from_pos'` (R12).
 *
 * ## Mutants (each leg names the one it kills)
 * See each test. Mutants are applied by the AUDITOR to the builder's code, not here.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { parseBusinessDate } from '@shareat/core/datetime';
import * as D from '@shareat/domain';
import { humanDate as humanDateOf } from '../../src/shared/refusal-leaf';
import { importTestDay, stubFetchers } from './_fixtures/pos-day';
import { asOrgOn, actorOf, R1_FIGURES, insertSalesRecheck, s6Fixture, uid } from './_fixtures/pos-s6';

const hd = (d: string) => humanDateOf(parseBusinessDate(d));
const sql = postgres(url, { max: 12 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const D1 = '2027-01-10';
const D2 = '2027-01-11';
const D3 = '2027-01-12';
const NEWDAY = '2027-01-20';

// ---- fixture: s6Fixture (Lipa LINKED, Cash+GCash, manager/admin) + a super admin + Batangas (never linked) -------
async function fixture(hint: string, o: { stock?: boolean } = {}) {
  const base = await s6Fixture(sql, `t382s2-${hint}`, o);
  const orgId = base.orgId;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Batangas') returning id`;
  const store2Id = b!.id;
  const [c2] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${store2Id}, 'Walk-in', true) returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of [base.storeId, store2Id]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const superId = await mk('Super', 'super_admin');
  // the manager also works at Batangas (typed days there, usage there)
  await sql`insert into person_store_scope (person_id, store_id) values (${base.managerId}, ${store2Id})`;
  return { ...base, store2Id, walkIn2Id: c2!.id, superId, superAdmin: actorOf(orgId, superId) };
}
type F = Awaited<ReturnType<typeof fixture>>;

// ---- helpers ------------------------------------------------------------------------------------------------
const sentence = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);
async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e) => e);
  expect(err, 'the call must refuse').toBeInstanceOf(Error);
  return sentence(err);
}
const S = {
  unlinkedImport: (n: string) => `${n} isn't linked to a POS store yet, so its sales can't be imported. An admin links it under Settings › POS link.`,
  notLinked: (n: string) => `${n} isn't linked to POS.`,
  figuresUnreadable: (n: string) => `${n} isn't linked to a POS store, so its POS figures can't be read.`,
  blank: 'Say why this store is being unlinked.',
  tooLong: 'Keep the reason under 500 characters.',
  unverified: (n: string) => `${n} has imported sales days that aren't verified yet (`,
  unverifiedTail: '). Verify or withdraw them before unlinking it.',
  changed: (n: string, d: string) => `${n}'s POS link changed while ${hd(d)} was being imported. Nothing was saved. Try again.`,
  held: (holder: string) => `That POS store is still held by ${holder}, which was unlinked. Link ${holder} to its own POS store first.`,
  w6: (n: string, dates: string) => `${n} still has typed sales days that aren't verified (${dates}). Verify or withdraw them before linking it to POS.`,
  usageUnlinked: (n: string) => `${n} isn't linked to a POS store yet, so its usage can't be pulled. An admin links it under Settings › POS link.`,
  usageTyped: (n: string, d: string) =>
    `${n}'s sales for ${hd(d)} were typed in before it was linked to POS, so there are no POS sold items to pull. Record that day's usage by hand under Inventory › Usage & wastage.`,
};

/** `unlinkStoreFromPos` through the barrel, called lazily so a missing function fails ITS leg, not the file. */
type UnlinkResult = { linkId: string; importedDays: number };
async function unlinkIn(tx: Tx, who: Actor, input: { storeId: string; reason: string }): Promise<UnlinkResult> {
  const fn = (D as unknown as Record<string, unknown>)['unlinkStoreFromPos'];
  if (typeof fn !== 'function') throw new Error('unlinkStoreFromPos is not exported from @shareat/domain (T-382 S2 not built)');
  return (fn as (tx: Tx, a: Actor, i: { storeId: string; reason: string }) => Promise<UnlinkResult>)(tx, who, input);
}
const unlink = (f: F, who: Actor, input: { storeId?: string; reason?: string } = {}) =>
  asOrgOn(f.orgId, (tx) => unlinkIn(tx, who, { storeId: input.storeId ?? f.storeId, reason: input.reason ?? 'wrong POS store' }));

const imp = (f: F, date: string, o: Partial<Parameters<typeof importTestDay>[2]> = {}) =>
  asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: date, ...o }));
const verify = (f: F, dayId: string) => asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId));
async function verifiedDay(f: F, date: string): Promise<string> {
  const { id } = await imp(f, date);
  await verify(f, id);
  return id;
}
const typedDay = (f: F, storeId: string, channelId: string, date: string, who: Actor = f.manager) =>
  asOrgOn(f.orgId, (tx) =>
    D.createSalesDay(tx, who, {
      storeId, businessDate: date, totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00',
      cashCollected: '1000.00', channels: [{ channelId, amount: '1000.00' }],
    }),
  );
const relink = (f: F, who: Actor, o: { storeId?: string; posStoreId: string; channelId?: string; taxType?: 'vat_inclusive' | 'non_vat' }) =>
  asOrgOn(f.orgId, (tx) =>
    D.linkStoreToPos(tx, who, {
      storeId: o.storeId ?? f.storeId, posStoreId: o.posStoreId, posStoreName: 'Lipa (POS)',
      salesChannelId: o.channelId ?? f.walkInId, posTaxType: o.taxType ?? 'vat_inclusive',
    }),
  );

type LinkRow = { pos_store_id: string; unlinked_at: Date | null; unlinked_by: string | null; unlink_reason: string | null; pos_tax_type: string };
const linkRow = async (storeId: string) =>
  (await sql<LinkRow[]>`select pos_store_id, unlinked_at, unlinked_by, unlink_reason, pos_tax_type from pos_v1_store_links where store_id = ${storeId}`)[0];
const auditOf = (orgId: string, action: string) =>
  sql<{ before: Record<string, unknown> | null; after: Record<string, unknown> | null; actor_person_id: string; entity: string; entity_id: string; source: string }[]>`
    select before, after, actor_person_id, entity, entity_id, source from audit_log where org_id = ${orgId} and action = ${action} order by id`;

/** Every row an unlink must NOT touch (I2), for the store, as stable JSON. */
async function snapshot(f: F): Promise<Record<string, string>> {
  // every statement names exactly one parameter, $1: the store id, or the org id for the journal tables
  const q = async (label: string, text: string, arg: string = f.storeId): Promise<[string, string]> => [
    label,
    JSON.stringify((await sql.unsafe(text, [arg])).map((r) => (r as unknown as { j: unknown }).j)),
  ];
  const days = `(select id from sales_days where store_id = $1)`;
  return Object.fromEntries(
    await Promise.all([
      q('sales_days', `select to_jsonb(t) j from sales_days t where store_id = $1 order by id`),
      q('tenders', `select to_jsonb(t) j from sales_day_tenders t where sales_day_id in ${days} order by id`),
      q('channels', `select to_jsonb(t) j from sales_day_channels t where sales_day_id in ${days} order by id`),
      q('feeds', `select to_jsonb(t) j from pos_v1_day_feeds t where store_id = $1 order by id`),
      q('corrections', `select to_jsonb(t) j from sales_day_pos_corrections t where store_id = $1 order by id`),
      q('entries', `select to_jsonb(t) j from journal_entries t where org_id = $1 order by id`, f.orgId),
      q('lines', `select to_jsonb(t) j from journal_lines t where entry_id in (select id from journal_entries where org_id = $1) order by id`, f.orgId),
    ]),
  );
}
const count = async (text: string, ...args: string[]): Promise<number> => Number(((await sql.unsafe(text, args)) as unknown as { n: string }[])[0]!.n);
const feedCount = (storeId: string, date?: string) =>
  date
    ? count(`select count(*)::text n from pos_v1_day_feeds where store_id = $1 and business_date = $2`, storeId, date)
    : count(`select count(*)::text n from pos_v1_day_feeds where store_id = $1`, storeId);
const dayCount = (storeId: string, date: string) =>
  count(`select count(*)::text n from sales_days where store_id = $1 and business_date = $2`, storeId, date);

// =====================================================================================================
describe('U1 - a super admin unlinks a store with three verified imported days', () => {
  it('the row is stamped; one audit row; { importedDays: 3 }; a typed day on a new date works; an import refuses with the unlinked sentence', async () => {
    const f = await fixture('u1');
    for (const d of [D1, D2, D3]) await verifiedDay(f, d);

    const out = await unlink(f, f.superAdmin, { reason: 'wrong POS store' });
    expect(out.importedDays).toBe(3);

    const row = await linkRow(f.storeId);
    expect(row, 'the link row stays (soft unlink)').toBeDefined();
    expect(row!.unlinked_at, 'unlinked_at is set').toBeInstanceOf(Date);
    expect(row!.unlinked_by).toBe(f.superId);
    expect(row!.unlink_reason).toBe('wrong POS store');
    expect(row!.pos_store_id, 'the row keeps its POS id').toBe(f.posStoreId);

    const audit = await auditOf(f.orgId, 'unlink_store_from_pos');
    expect(audit, 'exactly one audit row').toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity: 'pos_v1_store_links', entity_id: out.linkId, actor_person_id: f.superId, source: 'web' });
    expect(audit[0]!.before).toMatchObject({ storeId: f.storeId, posStoreId: f.posStoreId, salesChannelId: f.walkInId, posTaxType: 'vat_inclusive' });
    expect(audit[0]!.after).toMatchObject({ unlinkReason: 'wrong POS store' });
    expect((audit[0]!.after as Record<string, unknown>)['unlinkedAt'], 'after.unlinkedAt present').toBeTruthy();

    await expect(typedDay(f, f.storeId, f.walkInId, NEWDAY)).resolves.toHaveProperty('id');
    expect(await sentenceOf(imp(f, '2027-01-21'))).toBe(S.unlinkedImport('Lipa'));
  });
  // Mutants: the audit append skipped -> `audit` has 0 rows, red. `unlinked_at` not set -> the row/typed-day asserts, red.
});

describe('U0 - the function is exported', () => {
  it('unlinkStoreFromPos is a function on @shareat/domain', () => {
    expect(typeof (D as unknown as Record<string, unknown>)['unlinkStoreFromPos']).toBe('function');
  });
});

describe('U2 - I2: an unlink changes no day, tender, channel, feed, correction or journal row', () => {
  it('snapshot identical before and after; edit/re-import/correction/recheck refuse; void is ALLOWED and its figures stay (REV-9)', async () => {
    const f = await fixture('u2');
    const dayId = await verifiedDay(f, D1);
    await verifiedDay(f, D2);
    // a newer feed the correction attempt will name (raw insert: recheck batches need no link)
    const feedId = (
      await asOrgOn(f.orgId, (tx) =>
        insertSalesRecheck(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: D1, posStoreId: f.posStoreId, fetchedBy: f.managerId, figures: R1_FIGURES }),
      )
    ).ids.sales!;
    const before = await snapshot(f);

    await unlink(f, f.superAdmin);
    expect(await snapshot(f), 'I2: nothing but the link row and the audit log changed').toEqual(before);

    // each path refuses, and the refusals change nothing
    await expect(
      asOrgOn(f.orgId, (tx) =>
        D.editSalesDay(tx, f.manager, { salesDayId: dayId, totalSales: '1.00', unliSales: '1.00', alaCarteSales: '0.00', cashCollected: '1.00', channels: [{ channelId: f.walkInId, amount: '1.00' }] }),
      ),
      'a verified feed day cannot be edited',
    ).rejects.toBeInstanceOf(Error);
    expect(await sentenceOf(asOrgOn(f.orgId, (tx) => D.reimportSalesDay(tx, f.manager, { salesDayId: dayId }, stubFetchers().fetchers)))).toBe(S.unlinkedImport('Lipa'));
    expect(
      await sentenceOf(
        asOrgOn(f.orgId, (tx) =>
          D.postPosCorrection(tx, f.manager, { salesDayId: dayId, feedId, entryDate: '2027-01-20', reason: 'POS voided a cash receipt' }),
        ),
      ),
    ).toBe(S.figuresUnreadable('Lipa'));
    const stub = stubFetchers();
    expect(await sentenceOf(D.recheckPosDay(f.manager, { salesDayId: dayId }, stub.fetchers)), 'R9a: recheck refuses').toBe(S.figuresUnreadable('Lipa'));
    expect(await snapshot(f), 'the refusals stored nothing (no feed, no correction, no entry)').toEqual(before);

    // REV-9: void stays open, the figures stay, and a typed day can then take the date
    const figs = async () =>
      (await sql<Record<string, string>[]>`
        select total_sales, unli_sales, ala_carte_sales, other_discount, other_charges, cash_collected, online_collected, refunds
          from sales_days where id = ${dayId}`)[0];
    const figsBefore = await figs();
    await asOrgOn(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, dayId, 'imported against the wrong store'));
    expect((await sql`select status from sales_days where id = ${dayId}`)[0]!['status']).toBe('voided');
    expect(await figs(), 'the voided day keeps its figures').toEqual(figsBefore);
    await expect(typedDay(f, f.storeId, f.walkInId, D1)).resolves.toHaveProperty('id');
  });
  // Mutant: the unlink touching any day row (e.g. a status or source write) -> the snapshot assert, red. The recheck
  // leg is RED for a behavioural reason once S2 lands without R9a (recheck on HEAD reads no link and would store a feed).
});

describe('U3 - an admin (manage_chart_of_accounts) is refused', () => {
  it('AuthorizationError; the row is unchanged; no audit row', async () => {
    const f = await fixture('u3');
    await expect(unlink(f, f.admin)).rejects.toBeInstanceOf(AuthorizationError);
    const row = await linkRow(f.storeId);
    expect(row!.unlinked_at).toBeNull();
    expect(await auditOf(f.orgId, 'unlink_store_from_pos')).toHaveLength(0);
    // control: the super admin may
    await expect(unlink(f, f.superAdmin)).resolves.toMatchObject({ importedDays: 0 });
  });
  // Mutant: authorize under manage_chart_of_accounts -> the admin passes, red.
});

describe('U4 - I1: authorize comes before any lookup', () => {
  it('an admin naming a store that does not exist gets AuthorizationError, not "gone"', async () => {
    const f = await fixture('u4');
    await expect(unlink(f, f.admin, { storeId: crypto.randomUUID() })).rejects.toBeInstanceOf(AuthorizationError);
    // control: the super admin naming it gets the gone refusal (a plain refusal, not an authorization failure)
    const err = await unlink(f, f.superAdmin, { storeId: crypto.randomUUID() }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AuthorizationError);
  });
  // Mutant: the store lock before authorize -> the admin gets "gone", red.
});

describe('U5 - the reason is validated and trimmed', () => {
  it("'   ' -> the blank sentence; 501 characters -> the length sentence; '  wrong POS store  ' is stored trimmed; nothing written on a refusal", async () => {
    const f = await fixture('u5');
    expect(await sentenceOf(unlink(f, f.superAdmin, { reason: '   ' }))).toBe(S.blank);
    expect(await sentenceOf(unlink(f, f.superAdmin, { reason: 'x'.repeat(501) }))).toBe(S.tooLong);
    expect((await linkRow(f.storeId))!.unlinked_at, 'refusals wrote nothing').toBeNull();
    await unlink(f, f.superAdmin, { reason: '  wrong POS store  ' });
    expect((await linkRow(f.storeId))!.unlink_reason).toBe('wrong POS store');
  });
  it('control: exactly 500 characters is accepted', async () => {
    const f = await fixture('u5c');
    await unlink(f, f.superAdmin, { reason: 'y'.repeat(500) });
    expect((await linkRow(f.storeId))!.unlink_reason).toHaveLength(500);
  });
  // Mutant: no trim -> the stored reason keeps its spaces, red.
});

describe('U6 - not linked / already unlinked', () => {
  it('a never-linked store and an already-unlinked store -> "{Store} isn\'t linked to POS."; the second unlink leaves the first reason and time', async () => {
    const f = await fixture('u6');
    expect(await sentenceOf(unlink(f, f.superAdmin, { storeId: f.store2Id }))).toBe(S.notLinked('Batangas'));
    await unlink(f, f.superAdmin, { reason: 'first reason' });
    const first = await linkRow(f.storeId);
    expect(await sentenceOf(unlink(f, f.superAdmin, { reason: 'second reason' }))).toBe(S.notLinked('Lipa'));
    const after = await linkRow(f.storeId);
    expect(after!.unlink_reason).toBe('first reason');
    expect(after!.unlinked_at!.getTime()).toBe(first!.unlinked_at!.getTime());
    expect(await auditOf(f.orgId, 'unlink_store_from_pos'), 'one unlink, one audit row').toHaveLength(1);
  });
  // Mutant: the "already unlinked" check removed -> the second call overwrites the reason, red.
});

describe('U7 - R3: an unlink waits for every imported day to be verified or withdrawn', () => {
  it('an OPEN feed day -> refuses naming its date', async () => {
    const f = await fixture('u7o');
    await imp(f, D1);
    const s = await sentenceOf(unlink(f, f.superAdmin));
    expect(s.startsWith(S.unverified('Lipa'))).toBe(true);
    expect(s).toContain(hd(D1));
    expect(s.endsWith(S.unverifiedTail)).toBe(true);
    expect((await linkRow(f.storeId))!.unlinked_at).toBeNull();
  });
  it('a SUBMITTED feed day -> the same', async () => {
    const f = await fixture('u7s');
    const { id } = await imp(f, D1);
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.manager, id));
    const s = await sentenceOf(unlink(f, f.superAdmin));
    expect(s).toContain(hd(D1));
    expect(s.startsWith(S.unverified('Lipa'))).toBe(true);
  });
  it('control: only verified and voided feed days -> unlinks', async () => {
    const f = await fixture('u7v');
    await verifiedDay(f, D1);
    const { id } = await imp(f, D2);
    await asOrgOn(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, id, 'imported in error'));
    await expect(unlink(f, f.superAdmin)).resolves.toMatchObject({ importedDays: 1 });
    expect((await linkRow(f.storeId))!.unlinked_at).toBeInstanceOf(Date);
  });
  // Mutants: `submitted` left out of the filter -> the submitted leg unlinks, red. `verified` included -> the control refuses, red.
});

describe('U8 - R8 relink after an unlink (REV-1: the full UNIQUE stays)', () => {
  it('the SAME store links again to its old POS id: live, the three fields NULL, audit before.unlinkReason is the old reason, old feeds keep P1; a typed create then refuses', async () => {
    const f = await fixture('u8a');
    await verifiedDay(f, D1);
    await unlink(f, f.superAdmin, { reason: 'wrong POS store' });
    await relink(f, f.admin, { posStoreId: f.posStoreId });
    const row = await linkRow(f.storeId);
    expect(row).toMatchObject({ pos_store_id: f.posStoreId, unlinked_at: null, unlinked_by: null, unlink_reason: null });
    const audits = await auditOf(f.orgId, 'link_store_to_pos');
    expect(audits.at(-1)!.before, 'the relink audit carries the old unlink reason').toMatchObject({ unlinkReason: 'wrong POS store' });
    expect((audits.at(-1)!.before as Record<string, unknown>)['unlinkedAt'], 'and when').toBeTruthy();
    const feedPosIds = await sql<{ pos_store_id: string }[]>`select distinct pos_store_id from pos_v1_day_feeds where store_id = ${f.storeId}`;
    expect(feedPosIds.map((r) => r.pos_store_id), 'history is kept: the old feeds still carry P1').toEqual([f.posStoreId]);
    // the link is LIVE again: the store takes imports and refuses typed days
    expect(await sentenceOf(typedDay(f, f.storeId, f.walkInId, NEWDAY))).toBe('Lipa takes its sales from POS. Import the day instead.');
    await expect(imp(f, '2027-01-21')).resolves.toHaveProperty('id');
  });

  it('the SAME store links to a free P2: live on P2, the old feeds still carry P1', async () => {
    const f = await fixture('u8b');
    await verifiedDay(f, D1);
    await unlink(f, f.superAdmin);
    const p2 = uid('pos-p2');
    await relink(f, f.admin, { posStoreId: p2 });
    expect(await linkRow(f.storeId)).toMatchObject({ pos_store_id: p2, unlinked_at: null, unlinked_by: null, unlink_reason: null });
    const old = await sql<{ pos_store_id: string }[]>`select distinct pos_store_id from pos_v1_day_feeds where store_id = ${f.storeId} and business_date = ${D1}`;
    expect(old.map((r) => r.pos_store_id)).toEqual([f.posStoreId]);
  });

  it('ANOTHER store trying P1 while Lipa is unlinked -> "still held by Lipa, which was unlinked"; control: a live holder keeps the old wording', async () => {
    const f = await fixture('u8c');
    // control first: Lipa is LIVE on P1
    const live = await sentenceOf(relink(f, f.admin, { storeId: f.store2Id, posStoreId: f.posStoreId, channelId: f.walkIn2Id }));
    expect(live).toBe('That POS store is already linked to Lipa.');
    await unlink(f, f.superAdmin);
    expect(await sentenceOf(relink(f, f.admin, { storeId: f.store2Id, posStoreId: f.posStoreId, channelId: f.walkIn2Id }))).toBe(S.held('Lipa'));
    expect(await linkRow(f.store2Id), 'Batangas got no link').toBeUndefined();
  });

  it('a typed day entered while unlinked and not verified -> the relink refuses with the W6 sentence', async () => {
    const f = await fixture('u8d');
    await unlink(f, f.superAdmin);
    await typedDay(f, f.storeId, f.walkInId, NEWDAY);
    expect(await sentenceOf(relink(f, f.admin, { posStoreId: f.posStoreId }))).toBe(S.w6('Lipa', hd(NEWDAY)));
    expect((await linkRow(f.storeId))!.unlinked_at, 'still unlinked').toBeInstanceOf(Date);
  });
  // Mutants: `updateLink` not clearing unlinked_at -> after the relink the store still takes typed days, so the typed-create
  // assert in leg 1 goes red. `getLinkByPosStoreId` filtered to live rows -> Batangas gets the raw 23505 sentence, leg 3 red.
});

describe('U9 - the channel guard follows the live link', () => {
  it("after an unlink the old link's channel can be retired; before it, it cannot (control)", async () => {
    const f = await fixture('u9');
    const retire = () => asOrgOn(f.orgId, (tx) => D.setSalesChannelActive(tx, f.admin, { channelId: f.walkInId, isActive: false }));
    expect(await sentenceOf(retire()), 'control: a LIVE link guards its channel').toContain('Change the POS link first');
    await unlink(f, f.superAdmin);
    await expect(retire()).resolves.toBeUndefined();
    const [c] = await sql<{ is_active: boolean }[]>`select is_active from sales_channels where id = ${f.walkInId}`;
    expect(c!.is_active).toBe(false);
  });
  // Mutant: getLinkByChannel unfiltered -> the retire still refuses, red.
});

// ---- U10: R5, two real connections ------------------------------------------------------------------------
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}
async function waitingOnLock(pid: number, settled: Promise<unknown>, timeoutMs = 5000): Promise<boolean> {
  const stop = settled.then(() => true, () => true);
  const poll = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql`
        select 1 from pg_stat_activity
         where datname = current_database() and pid = ${pid} and wait_event_type = 'Lock' and wait_event = any(${['transactionid', 'tuple']})`;
      if (rows.length > 0) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  })();
  return Promise.race([poll, stop.then(() => false)]);
}
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
/**
 * A holds its transaction open after `opA`; B (a different connection) runs `opB`. Returns whether B blocked on a row
 * lock while A held, and both outcomes. A is committed (gate released) after B has blocked or settled.
 */
async function race<TA, TB>(f: F, opA: (tx: Tx) => Promise<TA>, opB: (tx: Tx) => Promise<TB>) {
  const aReady = deferred<void>();
  const gate = deferred<void>();
  const aP: Promise<Settled<TA>> = asOrgOn(f.orgId, async (tx) => {
    try {
      const value = await opA(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    } catch (error) {
      aReady.resolve();
      throw error;
    }
  }).then((value) => ({ ok: true, value }) as const, (error) => ({ ok: false, error }) as const);
  await aReady.promise;
  const pid = deferred<number>();
  const bP: Promise<Settled<TB>> = asOrgOn(f.orgId, async (tx) => {
    const rows = await tx.execute(dsql`select pg_backend_pid() as pid`);
    pid.resolve(Number((rows as unknown as { pid: number }[])[0]?.pid));
    return opB(tx);
  }).then((value) => ({ ok: true, value }) as const, (error) => ({ ok: false, error }) as const);
  const bWaited = await waitingOnLock(await pid.promise, bP);
  gate.resolve();
  const [a, b] = await Promise.all([aP, bP]);
  return { a, b, bWaited };
}
const mustBeOk = <T>(r: Settled<T>, what: string): T => {
  if (!r.ok) throw new Error(`${what} failed: ${sentence(r.error)}`);
  return r.value;
};
const failedWith = (r: Settled<unknown>): string => {
  expect(r.ok, 'B must refuse').toBe(false);
  return r.ok ? '' : sentence(r.error);
};

describe('U10 - R5: the import re-reads the link under the store lock (two connections)', () => {
  it('(a) A unlinks and holds; B imports a NEW date and blocks on the store lock; after A commits B refuses with the link-changed sentence; no feed rows, no day', async () => {
    const f = await fixture('u10a');
    const stub = stubFetchers();
    const { a, b, bWaited } = await race(
      f,
      (tx) => unlinkIn(tx, f.superAdmin, { storeId: f.storeId, reason: 'wrong POS store' }),
      (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: NEWDAY, fetchers: stub.fetchers }),
    );
    mustBeOk(a, 'A (the unlink)');
    expect(bWaited, 'B must block on the store row while A holds it (R5 takes the store FOR KEY SHARE)').toBe(true);
    expect(failedWith(b)).toBe(S.changed('Lipa', NEWDAY));
    expect(await feedCount(f.storeId, NEWDAY), 'zero feed rows for the date').toBe(0);
    expect(await dayCount(f.storeId, NEWDAY), 'zero days for the date').toBe(0);
    expect(stub.calls.every((c) => c.posStoreId === f.posStoreId), 'B had fetched from P1 before it blocked').toBe(true);
    expect(stub.calls.length, 'B fetched (both kinds) before the store lock').toBeGreaterThan(0);
  });
  // Mutants: no re-read under the lock -> after the wait B inserts and 0185 answers with the raw constraint sentence, red.
  // No store lock at all -> bWaited false, red.

  it('(b) A relinks to a free P2 and holds; B (fetched from P1) blocks; after A commits B refuses with the same sentence', async () => {
    const f = await fixture('u10b');
    const stub = stubFetchers();
    const p2 = uid('pos-p2');
    const { a, b, bWaited } = await race(
      f,
      async (tx) => {
        await D.linkStoreToPos(tx, f.admin, { storeId: f.storeId, posStoreId: p2, posStoreName: 'Lipa (POS)', salesChannelId: f.walkInId, posTaxType: 'vat_inclusive' });
      },
      (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: NEWDAY, fetchers: stub.fetchers }),
    );
    mustBeOk(a, 'A (the relink)');
    expect(bWaited, 'B must block on the store lock').toBe(true);
    expect(failedWith(b)).toBe(S.changed('Lipa', NEWDAY));
    expect(stub.calls.every((c) => c.posStoreId === f.posStoreId), 'B asked P1').toBe(true);
    expect(await feedCount(f.storeId, NEWDAY)).toBe(0);
    expect(await dayCount(f.storeId, NEWDAY)).toBe(0);
  });
  // Mutant: no re-read -> B imports P1's figures under the store now linked to P2, red. No store lock -> red.

  it('(c) B imports first and commits an open day; A then unlinks and refuses (R3)', async () => {
    const f = await fixture('u10c');
    await imp(f, NEWDAY);
    const s = await sentenceOf(unlink(f, f.superAdmin));
    expect(s.startsWith(S.unverified('Lipa'))).toBe(true);
    expect(s).toContain(hd(NEWDAY));
    expect((await linkRow(f.storeId))!.unlinked_at).toBeNull();
  });

  it('(d) REV-4: A relinks P1 from vat_inclusive to non_vat and holds; B, fetched under the old link, blocks; after A commits B refuses', async () => {
    const f = await fixture('u10d');
    const stub = stubFetchers();
    const { a, b, bWaited } = await race(
      f,
      async (tx) => {
        await D.linkStoreToPos(tx, f.admin, { storeId: f.storeId, posStoreId: f.posStoreId, posStoreName: 'Lipa (POS)', salesChannelId: f.walkInId, posTaxType: 'non_vat' });
      },
      (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: NEWDAY, fetchers: stub.fetchers }),
    );
    mustBeOk(a, 'A (the tax-type relink)');
    expect(bWaited, 'B must block on the store lock').toBe(true);
    expect(failedWith(b)).toBe(S.changed('Lipa', NEWDAY));
    expect(await dayCount(f.storeId, NEWDAY), 'no day derived under the old tax type').toBe(0);
    expect((await linkRow(f.storeId))!.pos_tax_type).toBe('non_vat');
  });
  // Mutant: only posStoreId compared -> the same POS id passes the compare, B imports a vat_inclusive day, red.
});

describe('U11 - R7 usage pulls after an unlink (REV-7)', () => {
  const items = [{ key: 'A', name: 'A', physicalQty: 3 }];
  const plan = (f: F, salesDayId: string, storeId: string, who: Actor) =>
    asOrgOn(f.orgId, (tx) => D.buildPlan(tx, who, { orgId: f.orgId, storeId, salesDayId, locationId: f.kitchen }));
  const reason = (r: { ok: boolean; reason?: string }): string => {
    expect(r.ok, 'must be refused').toBe(false);
    return String(r.reason);
  };

  it('a verified FEED day on the unlinked store builds its plan from the stored sold items', async () => {
    const f = await fixture('u11a', { stock: true });
    const { id } = await imp(f, D1, { soldItems: items });
    await verify(f, id);
    await unlink(f, f.superAdmin);
    const out = await plan(f, id, f.storeId, f.manager);
    expect(out.ok, out.ok ? '' : out.reason).toBe(true);
    if (out.ok) expect(out.lines.find((l) => l.key === 'direct:A')?.quantity).toBe('3.000');
  });
  // Mutant: the link read kept for feed days -> the plan refuses with the unlinked sentence, red.

  it('a TYPED day of the unlinked store -> the unlinked sentence (the old one), not the typed one', async () => {
    const f = await fixture('u11b', { stock: true });
    await unlink(f, f.superAdmin);
    const typed = (await typedDay(f, f.storeId, f.walkInId, NEWDAY)).id;
    expect(reason(await plan(f, typed, f.storeId, f.manager))).toBe(S.usageUnlinked('Lipa'));
  });

  it('a typed day of a NEVER-linked store -> the unlinked sentence (every store in production today); passes on HEAD', async () => {
    const f = await fixture('u11c', { stock: true });
    const typed = (await typedDay(f, f.store2Id, f.walkIn2Id, NEWDAY)).id;
    expect(reason(await plan(f, typed, f.store2Id, f.manager))).toBe(S.usageUnlinked('Batangas'));
  });

  it('a typed day of a LINKED store (typed before the link) -> the typed sentence; passes on HEAD', async () => {
    const f = await fixture('u11d', { stock: true });
    const typed = (await typedDay(f, f.store2Id, f.walkIn2Id, NEWDAY)).id;
    await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, typed));
    await relink(f, f.admin, { storeId: f.store2Id, posStoreId: uid('pos-bat'), channelId: f.walkIn2Id });
    expect(reason(await plan(f, typed, f.store2Id, f.manager))).toBe(S.usageTyped('Batangas', NEWDAY));
  });
  // Mutant: the `typed` sentence used for every typed day -> legs b and c get the typed sentence, red.
});

describe('U12 - R9a: no correction or recheck of an old imported day after a relink', () => {
  /** A verified D1 day under P1 and a newer feed on R1's figures (what a correction would name). */
  async function drifted(f: F) {
    const { id: dayId } = await imp(f, D1);
    await verify(f, dayId);
    const feedId = (
      await asOrgOn(f.orgId, (tx) =>
        insertSalesRecheck(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: D1, posStoreId: f.posStoreId, fetchedBy: f.managerId, figures: R1_FIGURES }),
      )
    ).ids.sales!;
    return { dayId, feedId };
  }
  const correct = (f: F, dayId: string, feedId: string) =>
    asOrgOn(f.orgId, (tx) => D.postPosCorrection(tx, f.manager, { salesDayId: dayId, feedId, entryDate: '2027-01-20', reason: 'POS voided a cash receipt' }));
  const corrections = (dayId: string) => count(`select count(*)::text n from sales_day_pos_corrections where sales_day_id = $1`, dayId);
  const entries = (f: F) => count(`select count(*)::text n from journal_entries where org_id = $1`, f.orgId);

  async function expectRefused(f: F, dayId: string, feedId: string) {
    const entriesBefore = await entries(f);
    const feedsBefore = await feedCount(f.storeId);
    expect(await sentenceOf(correct(f, dayId, feedId))).toBe(S.figuresUnreadable('Lipa'));
    expect(await sentenceOf(D.recheckPosDay(f.manager, { salesDayId: dayId }, stubFetchers().fetchers))).toBe(S.figuresUnreadable('Lipa'));
    expect(await corrections(dayId), 'no correction row').toBe(0);
    expect(await entries(f), 'no journal entry').toBe(entriesBefore);
    expect(await feedCount(f.storeId), 'no feed added').toBe(feedsBefore);
  }

  it('unlink, relink to P2: the old P1 day refuses correction and recheck with the unlinked sentence; recheckRecentDays skips it and logs no failure', async () => {
    const f = await fixture('u12a');
    const { dayId, feedId } = await drifted(f);
    await unlink(f, f.superAdmin);
    await relink(f, f.admin, { posStoreId: uid('pos-p2') });
    await expectRefused(f, dayId, feedId);

    // a new import on P2, then the automatic recheck of the days before it
    await imp(f, D3);
    const stub = stubFetchers();
    const feedsOnOld = await feedCount(f.storeId, D1);
    const res = await D.recheckRecentDays(f.manager, f.storeId, D3, stub.fetchers);
    expect(res.rechecked, 'the old day is skipped').not.toContain(D1);
    expect(res.failed, 'and no failure is logged for it').toEqual([]);
    expect(await feedCount(f.storeId, D1), 'no feed stored for the old day').toBe(feedsOnOld);
    expect(stub.calls.filter((c) => c.businessDate === D1), 'POS is not asked about it').toEqual([]);
  });
  // Mutant: the guard dropped -> the correction posts under P2's link, red.

  it('same POS id, vat_inclusive -> non_vat: the basis predates link.updatedAt, so it refuses', async () => {
    const f = await fixture('u12b');
    const { dayId, feedId } = await drifted(f);
    await unlink(f, f.superAdmin);
    await relink(f, f.admin, { posStoreId: f.posStoreId, taxType: 'non_vat' });
    await expectRefused(f, dayId, feedId);
  });
  // Mutant: only posStoreId compared -> this leg red (same id).

  it('control: a store linked once and never relinked still corrects, and its recent days are still rechecked', async () => {
    const f = await fixture('u12c');
    const { dayId, feedId } = await drifted(f);
    await correct(f, dayId, feedId);
    expect(await corrections(dayId), 'the correction posts').toBe(1);

    const stub = stubFetchers();
    const res = await D.recheckRecentDays(f.manager, f.storeId, D3, stub.fetchers);
    expect(res.rechecked).toContain(D1);
  });
  // Mutant: the updatedAt check run when updatedAt is NULL (a never-relinked link) -> the control refuses, red.
});


// =====================================================================================================
// ✎AMEND-2 (commit 6891bd9)
const S2 = {
  already: (store: string) => `That POS store's sales were already imported for ${store}, so it can't be linked to another store.`,
};

describe('R10 (DEF-607) - a POS id with imported sales never links to a DIFFERENT store', () => {
  /** Lipa imports and verifies a day under its POS id P1, then is relinked to a free P2 (P1 is now free by the UNIQUE). */
  async function relinkedAway(hint: string) {
    const f = await fixture(hint);
    await verifiedDay(f, D1);
    const p2 = uid('pos-p2');
    await relink(f, f.admin, { posStoreId: p2 });
    return { f, p2 };
  }
  const batangasLinks = (f: F, posStoreId: string) => relink(f, f.admin, { storeId: f.store2Id, posStoreId, channelId: f.walkIn2Id });

  it('R10-a: Lipa relinked P1 -> P2; Batangas links P1 -> refused with the already-imported sentence; nothing written (RED on HEAD: it links)', async () => {
    const { f } = await relinkedAway('r10a');
    expect(await sentenceOf(batangasLinks(f, f.posStoreId))).toBe(S2.already('Lipa'));
    expect(await linkRow(f.store2Id), 'Batangas got no link').toBeUndefined();
    expect(await auditOf(f.orgId, 'link_store_to_pos')).toHaveLength(1); // only Lipa's relink
  });

  it('R10-a (not only live links): Lipa is then UNLINKED too, so no live link holds P1 or its feeds; Batangas is still refused', async () => {
    const { f } = await relinkedAway('r10a2');
    await unlink(f, f.superAdmin);
    expect(await sentenceOf(batangasLinks(f, f.posStoreId))).toBe(S2.already('Lipa'));
    expect(await linkRow(f.store2Id)).toBeUndefined();
  });

  it('R10-b (control, GREEN on HEAD): a POS id that was never imported, freed by a relink, CAN be linked to another store', async () => {
    const f = await fixture('r10b');
    const p3 = uid('pos-p3');
    await relink(f, f.admin, { posStoreId: p3 }); // Lipa on P3, no feed ever carries P3
    await relink(f, f.admin, { posStoreId: uid('pos-p2') }); // frees P3
    await expect(batangasLinks(f, p3)).resolves.toHaveProperty('linkId');
    expect((await linkRow(f.store2Id))!.pos_store_id).toBe(p3);
  });

  it('R10-c (control, GREEN on HEAD): the SAME store relinking back to its own old id is allowed', async () => {
    const { f } = await relinkedAway('r10c');
    await relink(f, f.admin, { posStoreId: f.posStoreId });
    expect((await linkRow(f.storeId))!.pos_store_id).toBe(f.posStoreId);
  });

  it('cross-org: the imported POS id (freed by its relink) is not refused and its store name is never shown', async () => {
    const other = await fixture('r10x-other');
    await verifiedDay(other, D1);
    await relink(other, other.admin, { posStoreId: uid('pos-away') }); // the other org freed its P1
    const mine = await fixture('r10x-mine');
    const out = await relink(mine, mine.admin, { posStoreId: other.posStoreId }).then(() => 'linked', (e) => sentence(e));
    expect(out, 'RLS and the org filter keep the other org invisible').toBe('linked');
  });
  // Mutants: the check dropped -> R10-a legs red. Live links only -> the second R10-a leg red. The check run across orgs
  // (no org filter / RLS bypass) -> the cross-org leg refuses, red (and would leak "Lipa" of another org).
});

describe('R9a on the DATABASE clock - the basis is judged by a DB stamp, never the app clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  /** Run `fn` with `Date` skewed by `ms` (timers left real), then restore. */
  async function skewed<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms });
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  }
  const pause = () => new Promise((r) => setTimeout(r, 30));

  it('a basis imported (DB time) BEFORE the relink is refused even when the app clock ran an hour ahead (RED on HEAD: fetched_at is the app clock)', async () => {
    const f = await fixture('clk1');
    const { id } = await skewed(3_600_000, () => imp(f, D1));
    await verify(f, id);
    await pause();
    await relink(f, f.admin, { posStoreId: f.posStoreId, taxType: 'non_vat' }); // same id: only updated_at moves
    const stub = stubFetchers();
    expect(await sentenceOf(D.recheckPosDay(f.manager, { salesDayId: id }, stub.fetchers))).toBe(S.figuresUnreadable('Lipa'));
    expect(stub.calls, 'POS is not asked').toHaveLength(0);
  });

  it('a basis imported AFTER the relink is NOT refused even when the app clock ran an hour behind (RED on HEAD: judged by the skewed clock)', async () => {
    const f = await fixture('clk2');
    await relink(f, f.admin, { posStoreId: f.posStoreId, taxType: 'non_vat' });
    await pause();
    // non_vat imports (vat_exclusive would not); the day is imported and verified with the clock behind
    const { id } = await skewed(-3_600_000, () => imp(f, D1));
    await verify(f, id);
    const stub = stubFetchers();
    await expect(D.recheckPosDay(f.manager, { salesDayId: id }, stub.fetchers)).resolves.toHaveProperty('salesDayId', id);
    expect(stub.calls.length, 'POS was asked (both kinds)').toBe(2);
  });
  // Mutant: the compare reads the app-written fetched_at (not DB-stamped) -> both legs red.
});
