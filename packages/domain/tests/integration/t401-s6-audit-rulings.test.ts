/**
 * T-401 S6 round 3 - the audit rulings A1-A12 (docs/tasks/401-erp-menu-catalog-master.md, "S6 audit rulings", binding). TESTER, RED first;
 * real Postgres, raw fixtures. Companions: t401-s6-close-and-scorecard.test.ts (A4 month close, A6), apps/erp t401-s6-usage-ui.test.ts (A7 flag,
 * A11), tests/unit/scheduler-job-hosting.test.ts (A1 units), t401-s6-pull-draft.test.ts (A2 rewritten d3).
 *
 * ## Names / meanings the tester ASSUMED (the spec names none) - the builder meets these or tells the tester
 *  - A1: the scheduler job is named `usage_auto_post`; `usageAutoPostSweep({ orgId, now })` records one `scheduler_runs` row per org for it
 *    (the period is the builder's choice); the script `scripts/usage-auto-post.ts` takes `--org=<id>` and `--manual`; audit source is
 *    'cron' by default and 'manual' with `--manual`; a skipped draft (count session on the room) makes the exit code non-zero;
 *  - A3: "covered" survives the line's deletion (the item is covered by its snapshot / the live pull); the refusal is a normal post refusal;
 *  - A4: the column is `stock_usage_lines.expected_qty numeric`, written when the pull creates the line, null for lines staff add by hand;
 *  - A5: "others" = other `usage` records of the same store + day (any room), posted or draft, never wastage; a prefill that floors to 0
 *    is an absent line or a 0 line (both read as 0 here);
 *  - A7: an EDITED pull draft = a line removed/added through the domain calls (removeUsageLine/addUsageLine);
 *  - A9: the creation of the system person writes at least one `audit_log` row whose entity_id is that person;
 *  - A10: "finalized_at" is where the draft was made: the tests move the record's created_at AND the pull's `*_finalized_at` stamps together.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, systemTransaction, stockUsageRepo, type Tx } from '@shareat/db';
import * as domainModule from '@shareat/domain';
import { addUsageLine, buildPlan, finalizeSections, postUsage, removeUsageLine, saveUsageDraft, voidPosUsagePull } from '@shareat/domain';
import { asOrg, makeDay, rawMap, refusalOf, sold, sql, stockUp, world, type World } from './t401-s5-setup';
import { usageRecordsOfDay } from './_fixtures/pull-draft';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const mod = domainModule as unknown as {
  autoPostDueUsageDrafts(tx: Tx, now: Date): Promise<{ posted: unknown[]; skipped: { recordId: string; reason: string }[] }>;
  usageAutoPostSweep(o: { orgId?: string; now?: Date }): Promise<{ outcomes: { orgName: string; posted: number; skipped: unknown[]; error?: string }[]; hadFailures: boolean }>;
};

const DAY = '2026-08-20';
const START = 1000;
const AFTER_DUE = new Date('2026-08-21T06:01:00Z'); // 14:01 Manila the next day
const EVENING = '2026-08-20T12:00:00Z';
const REPO = path.resolve(__dirname, '..', '..', '..', '..');

interface S { w: World; dayId: string; pullId: string; keys: string[] }

/** Store A, DAY: 'a' 10 sold -> Cheese x1 (expected 10); with `two`, 'b' 10 sold -> Rice x1 (expected 10). Kitchen plan built. */
async function scenario(hint: string, two = false): Promise<S> {
  const w = await world(hint);
  await rawMap(w, w.a.storeId, 'a', { mode: 'direct', itemId: w.cheese, quantityPerSale: '1' });
  await stockUp(w, w.a.storeId, w.a.kitchen, w.cheese, String(START));
  const items = [{ key: 'a', qty: 10 }];
  if (two) {
    await rawMap(w, w.a.storeId, 'b', { mode: 'direct', itemId: w.rice, quantityPerSale: '1' });
    await stockUp(w, w.a.storeId, w.a.kitchen, w.rice, String(START));
    items.push({ key: 'b', qty: 10 });
  }
  const dayId = await makeDay(w, w.a.storeId, DAY, sold(items));
  const p = await asOrg(w.orgId, (tx) => buildPlan(tx, w.staff, { orgId: w.orgId, storeId: w.a.storeId, salesDayId: dayId, locationId: w.a.kitchen }));
  if (!p.ok) throw new Error(`fixture: buildPlan refused: ${p.reason}`);
  return { w, dayId, pullId: p.pullId, keys: p.lines.filter((l) => !l.blocked).map((l) => l.key) };
}

async function mustFinalize(s: S) {
  const f = await asOrg(s.w.orgId, (tx) => finalizeSections(tx, s.w.manager, { pullId: s.pullId, sections: ['direct'], confirmedKeys: s.keys }));
  if (!f.ok) throw new Error(`fixture: finalize refused: ${f.reason}`);
}

/** Moves "when the pull was finalized" everywhere a builder could read it from. */
async function backdate(recordId: string, at = EVENING) {
  await sql`update stock_usage_records set created_at = ${at} where id = ${recordId}`;
  await sql`update pos_usage_pulls set direct_finalized_at = case when direct_finalized_at is null then null else ${at}::timestamptz end,
                                       recipe_finalized_at = case when recipe_finalized_at is null then null else ${at}::timestamptz end,
                                       orphan_finalized_at = case when orphan_finalized_at is null then null else ${at}::timestamptz end
             where id in (select pull_id from pos_usage_pull_lines where usage_record_id = ${recordId})`;
}

/** The pull's own draft (system author) for the store + day + room; backdated to the evening of the business date. */
async function pullDraftOf(w: World, locationId: string = w.a.kitchen) {
  const recs = (await usageRecordsOfDay(sql, w.a.storeId, DAY)).filter(
    (r) => r.locationId === locationId && ![w.staff.personId, w.manager.personId, w.admin.personId].includes(r.createdBy),
  );
  expect(recs, 'exactly one system-authored draft for the room').toHaveLength(1);
  await backdate(recs[0]!.id);
  return recs[0]!;
}

async function runAuto(now: Date, w: World) {
  const r = await systemTransaction((tx) => mod.autoPostDueUsageDrafts(tx, now));
  const own = new Set((await sql<{ id: string }[]>`select id from stock_usage_records where org_id = ${w.orgId}`).map((x) => x.id));
  return { posted: (r.posted as { recordId: string }[]).filter((x) => own.has(x.recordId)), skipped: r.skipped.filter((x) => own.has(x.recordId)) };
}

async function setActual(w: World, recordId: string, itemId: string, qty: string) {
  const [line] = await sql<{ id: string }[]>`select id from stock_usage_lines where record_id = ${recordId} and item_id = ${itemId}`;
  if (line) expect((await asOrg(w.orgId, (tx) => removeUsageLine(tx, w.staff, { recordId, lineId: line.id }))).ok).toBe(true);
  const a = await asOrg(w.orgId, (tx) => addUsageLine(tx, w.staff, { recordId, itemId, quantity: qty }));
  expect(a.ok, a.ok ? '' : a.reason).toBe(true);
}
async function deleteLine(w: World, recordId: string, itemId: string) {
  const [line] = await sql<{ id: string }[]>`select id from stock_usage_lines where record_id = ${recordId} and item_id = ${itemId}`;
  expect(line, 'the line to delete exists').toBeDefined();
  expect((await asOrg(w.orgId, (tx) => removeUsageLine(tx, w.staff, { recordId, lineId: line!.id }))).ok).toBe(true);
}

async function onHand(w: World, itemId: string): Promise<number> {
  const [r] = await sql<{ t: string }[]>`select coalesce(sum(quantity),0)::text as t from stock_movements where org_id = ${w.orgId} and item_id = ${itemId}`;
  return Number(r!.t);
}
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from stock_usage_records where id = ${id}`)[0]?.status ?? 'deleted';
const post = (w: World, recordId: string, reason?: string) =>
  asOrg(w.orgId, (tx) => postUsage(tx, w.manager, { recordId, ...(reason ? { verifyOutOfTolerance: { reason } } : {}) }));
const postRefusal = (w: World, recordId: string, reason?: string) => refusalOf(() => post(w, recordId, reason));
const staffDraft = async (w: World, locationId: string, itemId: string, qty: string) => {
  const r = await asOrg(w.orgId, (tx) =>
    saveUsageDraft(tx, w.staff, { orgId: w.orgId, storeId: w.a.storeId, locationId, kind: 'usage', usedOn: DAY, lines: [{ itemId, quantity: qty }] }),
  );
  if (!r.ok) throw new Error(`fixture: ${r.reason}`);
  return r.recordId;
};
async function freezeKitchen(w: World) {
  const [cs] = await sql<{ id: string }[]>`
    insert into count_sessions (org_id, store_id, status, counted_on, opened_by) values (${w.orgId}, ${w.a.storeId}, 'open', ${DAY}, ${w.manager.personId}) returning id`;
  await sql`insert into count_session_locations (session_id, location_id) values (${cs!.id}, ${w.a.kitchen})`;
  return cs!.id;
}

// ---------------------------------------------------------------------------------------------------------------------
describe('A1 - the auto-post is a hosted, recorded, loud job', () => {
  it('the sweep writes a scheduler_runs row for the org (job usage_auto_post). Mutant: the sweep is not a SCHEDULER_JOBS job and leaves no run record', async () => {
    const s = await scenario('a1r');
    await mustFinalize(s);
    await pullDraftOf(s.w);
    const r = await mod.usageAutoPostSweep({ orgId: s.w.orgId, now: AFTER_DUE });
    expect(r.hadFailures).toBe(false);
    const runs = await sql<{ outcome: string }[]>`select outcome from scheduler_runs where org_id = ${s.w.orgId} and job = 'usage_auto_post'`;
    expect(runs.length, 'one run record for the org').toBeGreaterThanOrEqual(1);
    expect(runs[0]!.outcome).toBe('ok');
  }, 180_000);

  const script = (w: World, ...flags: string[]) =>
    spawnSync('npx', ['tsx', 'scripts/usage-auto-post.ts', `--org=${w.orgId}`, ...flags], {
      cwd: REPO,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 150_000,
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL!, SYSTEM_DATABASE_URL: process.env.TEST_DATABASE_URL! },
    });

  it('the script exits NON-ZERO when a draft was skipped (so systemd shows the failure), and 0 once nothing is skipped. Mutant: a skip is only a printed warning', async () => {
    const s = await scenario('a1x');
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    const cs = await freezeKitchen(s.w);
    const bad = script(s.w);
    expect(bad.status, `skipped draft must fail the run. stdout: ${bad.stdout} stderr: ${bad.stderr}`).not.toBe(0);
    expect(await statusOf(d.id)).toBe('draft');
    await sql`update count_sessions set status = 'cancelled', closed_by = ${s.w.manager.personId}, closed_at = now() where id = ${cs}`;
    const ok = script(s.w);
    expect(ok.status, `clean run exits 0. stdout: ${ok.stdout} stderr: ${ok.stderr}`).toBe(0);
    expect(await statusOf(d.id)).toBe('posted');
  }, 300_000);

  it("--manual writes audit source 'manual'; the timer's run writes 'cron'. Mutant: --manual is read but ignored", async () => {
    const sm = await scenario('a1m');
    await mustFinalize(sm);
    const dm = await pullDraftOf(sm.w);
    const rm = script(sm.w, '--manual');
    expect(rm.status, `${rm.stdout} ${rm.stderr}`).toBe(0);
    const [am] = await sql<{ source: string }[]>`select source from audit_log where org_id = ${sm.w.orgId} and action = 'stock.usage_auto_posted' and entity_id::text = ${dm.id}`;
    expect(am?.source).toBe('manual');

    const sc = await scenario('a1c');
    await mustFinalize(sc);
    const dc = await pullDraftOf(sc.w);
    const rc = script(sc.w);
    expect(rc.status, `${rc.stdout} ${rc.stderr}`).toBe(0);
    const [ac] = await sql<{ source: string }[]>`select source from audit_log where org_id = ${sc.w.orgId} and action = 'stock.usage_auto_posted' and entity_id::text = ${dc.id}`;
    expect(ac?.source).toBe('cron');
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('A2 - the pull never touches a staff draft; only system-authored pull drafts auto-post', () => {
  it('a staff draft of a manual item (Coke) and the pull draft live side by side: the staff draft is byte-for-byte what staff typed. Mutant: the pull merges into the staff draft', async () => {
    const s = await scenario('a2a');
    await stockUp(s.w, s.w.a.storeId, s.w.a.kitchen, s.w.coke, '100');
    const sid = await staffDraft(s.w, s.w.a.kitchen, s.w.coke, '5');
    await mustFinalize(s);
    const recs = await usageRecordsOfDay(sql, s.w.a.storeId, DAY);
    expect(recs).toHaveLength(2);
    expect(recs.find((r) => r.id === sid)!.lines).toEqual({ [s.w.coke]: '5.000' });
    expect(recs.find((r) => r.id !== sid)!.lines).toEqual({ [s.w.cheese]: '10.000' });
  }, 180_000);

  it('a staff draft WITH lines is never auto-posted, even though the same store + day + room has a pull draft that is; the sweep does not report it as skipped either. Mutant: any draft of a day with a pull is due', async () => {
    const s = await scenario('a2b');
    const sid = await staffDraft(s.w, s.w.a.kitchen, s.w.cheese, '9');
    await mustFinalize(s);
    await sql`update stock_usage_records set created_at = ${EVENING} where id = ${sid}`;
    const pd = await pullDraftOf(s.w);
    const r = await runAuto(AFTER_DUE, s.w);
    expect(r.posted.map((x) => x.recordId)).toEqual([pd.id]);
    expect(await statusOf(sid), 'the staff draft waits for a manager').toBe('draft');
    expect(r.skipped.map((x) => x.recordId)).not.toContain(sid);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('A3 - a covered line staff deleted counts as an actual of 0', () => {
  it('manager post is refused without a reason and nothing moves; with a reason it posts what is left and writes the verification row. Mutant: a missing line is not checked', async () => {
    const s = await scenario('a3m', true);
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    await deleteLine(s.w, d.id, s.w.cheese);
    const no = await postRefusal(s.w, d.id);
    expect(no, 'a covered item with no line is out of band (0 of 10)').not.toBeNull();
    expect(no ?? '').toMatch(/Cheese/);
    expect(await statusOf(d.id)).toBe('draft');
    expect(await onHand(s.w, s.w.rice)).toBe(START);
    expect(await postRefusal(s.w, d.id, 'Cheese was not used today')).toBeNull();
    expect(await onHand(s.w, s.w.cheese), 'cheese stays: its line was deleted on purpose').toBe(START);
    expect(await onHand(s.w, s.w.rice)).toBe(START - 10);
    const [v] = await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${s.w.orgId} and action = 'stock.usage_tolerance_verified'`;
    expect(Number(v!.n), 'the cheese reason is on file').toBe(1);
  }, 180_000);

  it('auto-post re-adds the deleted line at expected and posts the whole draft. Mutant: auto-post posts the draft without the line', async () => {
    const s = await scenario('a3a', true);
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    await deleteLine(s.w, d.id, s.w.cheese);
    const r = await runAuto(AFTER_DUE, s.w);
    expect(r.posted.map((x) => x.recordId)).toEqual([d.id]);
    expect(await onHand(s.w, s.w.cheese), 'the cheese line came back at expected 10').toBe(START - 10);
    expect(await onHand(s.w, s.w.rice)).toBe(START - 10);
    const [l] = await sql<{ q: string }[]>`select quantity::text as q from stock_usage_lines where record_id = ${d.id} and item_id = ${s.w.cheese}`;
    expect(Number(l!.q)).toBe(10);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('A4 - every line carries its own expected snapshot', () => {
  it('the pull writes expected_qty on each line it creates (Cheese 10, Rice 10). Mutant: no snapshot column or never filled', async () => {
    const s = await scenario('a4s', true);
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    const rows = await sql<{ item_id: string; e: string | null }[]>`select item_id, expected_qty::text as e from stock_usage_lines where record_id = ${d.id}`;
    expect(Object.fromEntries(rows.map((r) => [r.item_id, r.e === null ? null : Number(r.e)]))).toEqual({ [s.w.cheese]: 10, [s.w.rice]: 10 });
  }, 180_000);

  it('a manager post judges the line against ITS snapshot: the menu map changes after the pull (live expected 1) and the 10 still posts clean. Mutant: live recomputation', async () => {
    const s = await scenario('a4p');
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    await sql`update pos_item_maps set quantity_per_sale = '0.1' where store_id = ${s.w.a.storeId} and pos_item_key = 'a'`;
    expect(await postRefusal(s.w, d.id), 'in band against the snapshot of 10').toBeNull();
    expect(await onHand(s.w, s.w.cheese)).toBe(START - 10);
    const [n] = await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${s.w.orgId} and action = 'stock.usage_tolerance_verified'`;
    expect(Number(n!.n)).toBe(0);
  }, 180_000);

  it("another room's draft of the same item and day does not push the pull's own line out of band at post. Mutant: the band is the day total against the live expected", async () => {
    const s = await scenario('a4o');
    await stockUp(s.w, s.w.a.storeId, s.w.a.display!, s.w.cheese, '100');
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    const other = await staffDraft(s.w, s.w.a.display!, s.w.cheese, '30');
    expect(await postRefusal(s.w, other, 'Display used thirty'), 'its own post needs a reason').toBeNull();
    expect(await postRefusal(s.w, d.id), "the pull draft's own 10 against its own snapshot of 10").toBeNull();
    expect(await statusOf(d.id)).toBe('posted');
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('A5 - the pull pre-fills expected minus what other records already hold (floor 0)', () => {
  it('a staff draft of 4 Cheese in another room, unposted: the pull draft carries 6. Mutant: pre-fill ignores other records', async () => {
    const s = await scenario('a5d', true);
    await staffDraft(s.w, s.w.a.display!, s.w.cheese, '4');
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    expect(d.lines[s.w.cheese]).toBe('6.000');
    expect(d.lines[s.w.rice], 'an item nothing else holds is the full expected').toBe('10.000');
  }, 180_000);

  it('4 already POSTED in another room: the pull draft carries 6 as well', async () => {
    const s = await scenario('a5p', true);
    await stockUp(s.w, s.w.a.storeId, s.w.a.display!, s.w.cheese, '100');
    const other = await staffDraft(s.w, s.w.a.display!, s.w.cheese, '4');
    expect(await postRefusal(s.w, other, 'Display used four')).toBeNull();
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    expect(d.lines[s.w.cheese]).toBe('6.000');
  }, 180_000);

  it('others already hold more than expected: the line floors at 0 (absent or 0), never negative; the other item is untouched', async () => {
    const s = await scenario('a5f', true);
    await staffDraft(s.w, s.w.a.display!, s.w.cheese, '15');
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    expect(Number(d.lines[s.w.cheese] ?? '0')).toBe(0);
    expect(d.lines[s.w.rice]).toBe('10.000');
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('A7 - voiding a pull whose draft staff edited keeps that draft, as a manual one', () => {
  it('edited draft: still a draft, unlinked from the pull, never auto-posted, stock unmoved. Mutant: the void deletes staff work, or leaves it auto-postable', async () => {
    const s = await scenario('a7e');
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    await setActual(s.w, d.id, s.w.cheese, '10.5');
    const out = await asOrg(s.w.orgId, (tx) => voidPosUsagePull(tx, s.w.manager, { pullId: s.pullId, reason: 'POS corrected' }));
    expect(out.ok).toBe(true);
    expect(await statusOf(d.id), 'staff work is not deleted').toBe('draft');
    const [l] = await sql<{ q: string }[]>`select quantity::text as q from stock_usage_lines where record_id = ${d.id} and item_id = ${s.w.cheese}`;
    expect(Number(l!.q)).toBe(10.5);
    const [linked] = await sql<{ n: string }[]>`select count(*)::text as n from pos_usage_pull_lines where usage_record_id = ${d.id}`;
    expect(Number(linked!.n), 'no live pull line points at it any more').toBe(0);
    const r = await runAuto(new Date('2026-09-30T06:01:00Z'), s.w);
    expect(r.posted).toEqual([]);
    expect(r.skipped.map((x) => x.recordId)).not.toContain(d.id);
    expect(await statusOf(d.id)).toBe('draft');
    expect(await onHand(s.w, s.w.cheese)).toBe(START);
  }, 180_000);

  it('untouched draft: deleted (or void) by the void, as before', async () => {
    const s = await scenario('a7u');
    await mustFinalize(s);
    await pullDraftOf(s.w);
    const out = await asOrg(s.w.orgId, (tx) => voidPosUsagePull(tx, s.w.manager, { pullId: s.pullId, reason: 'POS corrected' }));
    expect(out.ok).toBe(true);
    expect(await usageRecordsOfDay(sql, s.w.a.storeId, DAY)).toEqual([]);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('A9 - the system person is made once, under a lock, with an audit row', () => {
  it('two first-use calls at the same moment create ONE person and both get its id. Mutant: no advisory lock (two persons)', async () => {
    const w = await world('a9');
    const where = async () =>
      sql<{ id: string }[]>`select id from persons where org_id = ${w.orgId} and kind = 'terminal' and is_active = false`;
    expect(await where(), 'control: none yet').toHaveLength(0);
    const first = asOrg(w.orgId, async (tx) => {
      const id = await stockUsageRepo.systemAuthorId(tx, w.orgId);
      await new Promise((r) => setTimeout(r, 1500)); // hold the transaction open so the second call overlaps it
      return id;
    });
    await new Promise((r) => setTimeout(r, 300));
    const second = asOrg(w.orgId, (tx) => stockUsageRepo.systemAuthorId(tx, w.orgId));
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(await where(), 'one system person').toHaveLength(1);
    const audit = await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${w.orgId} and entity_id::text = ${a}`;
    expect(Number(audit[0]!.n), 'creating the person is audited, once').toBe(1);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('A10 - due = the later of 14:00 Manila the next day and finalized + 4 hours', () => {
  it('finalized at 13:00 Manila the next day: nothing at 14:01 or 16:59; posts at 17:01. Mutant: due at 14:00 only', async () => {
    const s = await scenario('a10');
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    await backdate(d.id, '2026-08-21T05:00:00Z'); // 13:00 Manila on the 21st
    const at1401 = await runAuto(new Date('2026-08-21T06:01:00Z'), s.w);
    expect(at1401.posted, '14:01 is after 14:00 but only 1h after the draft was made').toHaveLength(0);
    expect(await statusOf(d.id)).toBe('draft');
    const at1659 = await runAuto(new Date('2026-08-21T08:59:00Z'), s.w);
    expect(at1659.posted).toHaveLength(0);
    const at1701 = await runAuto(new Date('2026-08-21T09:01:00Z'), s.w);
    expect(at1701.posted.map((x) => x.recordId)).toEqual([d.id]);
    expect(await statusOf(d.id)).toBe('posted');
  }, 180_000);

  it('control: finalized the evening of the business date, due 14:00 the next day as before', async () => {
    const s = await scenario('a10c');
    await mustFinalize(s);
    const d = await pullDraftOf(s.w);
    expect((await runAuto(new Date('2026-08-21T05:59:00Z'), s.w)).posted).toHaveLength(0);
    expect((await runAuto(new Date('2026-08-21T06:01:00Z'), s.w)).posted.map((x) => x.recordId)).toEqual([d.id]);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('open item - an untouched pull draft with nothing to post is cleaned up, not skipped forever', () => {
  it('everything the POS sold is already held by another record: the sweep leaves no skipped entry and no empty draft; no stock moves for it. Mutant: skipped on every run', async () => {
    const s = await scenario('e0');
    await staffDraft(s.w, s.w.a.display!, s.w.cheese, '15'); // already holds more than the expected 10
    await mustFinalize(s);
    const empties = (await usageRecordsOfDay(sql, s.w.a.storeId, DAY)).filter(
      (r) => r.locationId === s.w.a.kitchen && ![s.w.staff.personId, s.w.manager.personId, s.w.admin.personId].includes(r.createdBy),
    );
    for (const e of empties) await backdate(e.id);
    const first = await runAuto(AFTER_DUE, s.w);
    expect(first.skipped, 'nothing to post is not a refusal to report').toEqual([]);
    expect(first.posted).toEqual([]);
    const left = (await usageRecordsOfDay(sql, s.w.a.storeId, DAY)).filter((r) => r.createdBy !== s.w.staff.personId);
    expect(left, 'no empty system draft is left behind').toEqual([]);
    const second = await runAuto(AFTER_DUE, s.w);
    expect(second.skipped).toEqual([]);
    expect(await onHand(s.w, s.w.cheese)).toBe(START);
  }, 180_000);
});
