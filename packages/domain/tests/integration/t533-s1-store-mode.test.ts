/**
 * T-533 S1 (TESTER, written FIRST) - setStorePosMode against a real database. docs/tasks/533-pos-lipa-switch.md R1; Ian's answers O1 (bible row 456).
 *
 *   packages/domain/src/pos/store-mode.ts (new)
 *     setStorePosMode(tx, actor, { storeId, mode: 'off'|'test'|'live', liveFrom?, reason }, { keyFilePresent, today? })
 *       -> { changed, mode, liveFrom, stateVersion }
 *   Who: `manage_stores` (admin, super_admin) checked FIRST, then the role itself must be exactly admin or super_admin (a manager given `manage_stores` by hand is refused).
 *   The pure rules (every sentence, every limit) are `src/pos/store-mode.test.ts`; THIS file proves the facts are read and written right: the row, state_version,
 *   the audit row, "a sales day already exists", "a Z already closed", the pre-flight gate, and that a refused call leaves nothing behind.
 *   Every pass has its refusal in the same file. Made-up data only; runs on any `_test` database.
 */
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError } from '@shareat/auth';
import { advisoryLocksRepo, RefusalError } from '@shareat/db';
import { asOrg, auditRows, closeAll, sql, stateVersionOf, uuid, type Fx } from './_fixtures/t525-pos';
import { readyStore } from './_fixtures/t533-store-ready';
import { insertDerivedSalesDayRow } from './_fixtures/pos-day';
import { setStorePosMode } from '../../src/pos/store-mode';

afterAll(closeAll);

const TODAY = '2026-12-01';
const LIVE_FROM = '2026-12-07';
const DEPS = { keyFilePresent: () => true, today: TODAY };

type Input = { storeId?: string; mode: unknown; liveFrom?: unknown; reason?: unknown };
type Deps = { keyFilePresent: () => boolean; today?: string; now?: () => Date };
const set = (f: Fx, input: Input, actor: Fx['admin'] = f.admin, deps: Deps = DEPS) =>
  asOrg(f.orgId, (tx) => setStorePosMode(tx, actor, { storeId: f.storeId, reason: 'Lipa soak', ...input } as never, deps));
const live = (f: Fx, liveFrom: unknown = LIVE_FROM, actor: Fx['admin'] = f.admin) => set(f, { mode: 'live', liveFrom, reason: 'Lipa goes live' }, actor);

const posRow = async (f: Fx, storeId = f.storeId) =>
  (
    await sql<{ id: string; mode: string; live_from: string | null; changed_by: string; state_version: number }[]>`
      select id, mode, live_from::text, changed_by, state_version::int from pos_stores where store_id = ${storeId}`
  )[0];
const auditCount = async (f: Fx) => (await sql<{ n: number }[]>`select count(*)::int n from audit_log where org_id = ${f.orgId} and action = 'pos.store_mode_set'`)[0]!.n;

async function expectRefusal(p: Promise<unknown>, sentence: RegExp | string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  const said = (err as RefusalError).userMessage;
  if (typeof sentence === 'string') expect(said).toContain(sentence);
  else expect(said).toMatch(sentence);
}
async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authorization refusal, got success').not.toBeNull();
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

/** A Z (the day close) of the store on `date`, by raw SQL: the domain only ever reads that one exists. */
async function zOn(f: Fx, date: string, zNo = 1): Promise<void> {
  const [t] = await sql<{ id: string }[]>`select id from pos_terminals where store_id = ${f.storeId} and terminal_no = 1`;
  await sql`
    insert into pos_day_closes (org_id, store_id, terminal_id, z_no, business_date, window_start, window_end, receipt_count, gross_total, closed_by, approved_by)
    values (${f.orgId}, ${f.storeId}, ${t!.id}, ${zNo}, ${date}, ${`${date}T04:00:00+08:00`}, ${`${date}T22:00:00+08:00`}, 3, '1000.00', ${f.managerId}, ${f.adminId})`;
}

describe('R1 setStorePosMode - an admin switches a ready store to live on a future date', () => {
  it('writes mode live and live_from, changed_by, state_version +1, and exactly one pos.store_mode_set audit row with before and after', async () => {
    const f = await readyStore('test');
    const v0 = await stateVersionOf(f);
    const r = await live(f);
    expect(r).toMatchObject({ changed: true, mode: 'live', liveFrom: LIVE_FROM });
    const row = (await posRow(f))!;
    expect(row).toMatchObject({ mode: 'live', live_from: LIVE_FROM, changed_by: f.adminId, state_version: v0 + 1 });
    expect(r.stateVersion).toBe(v0 + 1);

    const audit = await auditRows(f, 'pos.store_mode_set');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_person_id: f.adminId, store_id: f.storeId, entity_id: row.id });
    expect(audit[0]!.before).toMatchObject({ mode: 'test', liveFrom: null });
    expect(audit[0]!.after).toMatchObject({ mode: 'live', liveFrom: LIVE_FROM, reason: 'Lipa goes live' });
  });

  it('today itself is allowed (the first day of the new POS may be today)', async () => {
    const f = await readyStore('test');
    await expect(live(f, TODAY)).resolves.toMatchObject({ changed: true, mode: 'live', liveFrom: TODAY });
  });

  it('a super_admin may too', async () => {
    const f = await readyStore('test');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Sam Super') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'super_admin')`;
    await expect(live(f, LIVE_FROM, { personId: p!.id, orgId: f.orgId })).resolves.toMatchObject({ changed: true, mode: 'live' });
    expect((await posRow(f))!.changed_by).toBe(p!.id);
  });
});

describe('R1 setStorePosMode - who may switch (Ian, row 456: admin and super_admin only)', () => {
  it('a store manager is refused, a cashier is refused, and nothing changed: no row change, no audit row', async () => {
    const f = await readyStore('test');
    const before = { row: await posRow(f), audit: await auditCount(f) };
    await expectAuthRefusal(live(f, LIVE_FROM, f.manager));
    await expectAuthRefusal(live(f, LIVE_FROM, f.counter));
    await expectAuthRefusal(set(f, { mode: 'off' }, f.manager));
    expect({ row: await posRow(f), audit: await auditCount(f) }).toEqual(before);
  });

  it('a manager given manage_stores BY HAND is still refused (the role must be exactly admin or super_admin), in words, and nothing changed', async () => {
    const f = await readyStore('test');
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${f.managerId}, 'manage_stores', ${f.adminId}, 'grant')`;
    const before = { row: await posRow(f), audit: await auditCount(f) };
    await expectRefusal(live(f, LIVE_FROM, f.manager), /admin/i);
    await expectRefusal(set(f, { mode: 'test' }, f.manager), /admin/i);
    expect({ row: await posRow(f), audit: await auditCount(f) }).toEqual(before);
  });

  it('control for the three above: the same call by the admin succeeds', async () => {
    const f = await readyStore('test');
    await expect(live(f)).resolves.toMatchObject({ changed: true });
  });
});

describe('R1 setStorePosMode - test and off are free for an admin (no pre-flight, no date)', () => {
  it('a store with nothing set up (pre-flight full of blocking items) can still be set to TEST, then OFF', async () => {
    const f = await readyStore('off', { rules: false });
    const v0 = await stateVersionOf(f);
    await expect(set(f, { mode: 'test', reason: 'practice' })).resolves.toMatchObject({ changed: true, mode: 'test', liveFrom: null });
    expect(await posRow(f)).toMatchObject({ mode: 'test', live_from: null, state_version: v0 + 1 });
    await expect(set(f, { mode: 'off', reason: 'done practising' })).resolves.toMatchObject({ changed: true, mode: 'off' });
    expect(await posRow(f)).toMatchObject({ mode: 'off', live_from: null, state_version: v0 + 2 });
    expect(await auditCount(f)).toBe(2);
  });

  it('the first time (no pos_stores row yet) the row is created, off first, then set: changed_by the admin, state_version 1, audit before = off', async () => {
    const f = await readyStore('test');
    expect(await posRow(f, f.store2Id)).toBeUndefined();
    await expect(set(f, { storeId: f.store2Id, mode: 'test', reason: 'first switch' })).resolves.toMatchObject({ changed: true, mode: 'test' });
    expect(await posRow(f, f.store2Id)).toMatchObject({ mode: 'test', live_from: null, changed_by: f.adminId, state_version: 1 });
    const audit = (await auditRows(f, 'pos.store_mode_set')).filter((a) => a.store_id === f.store2Id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toMatchObject({ mode: 'off', liveFrom: null });
    expect(audit[0]!.after).toMatchObject({ mode: 'test', reason: 'first switch' });
  });

  it('setting the mode it already has changes nothing: changed false, no audit row, no state_version bump', async () => {
    const f = await readyStore('test');
    const before = { row: await posRow(f), audit: await auditCount(f) };
    await expect(set(f, { mode: 'test' })).resolves.toMatchObject({ changed: false, mode: 'test' });
    expect({ row: await posRow(f), audit: await auditCount(f) }).toEqual(before);
  });
});

describe('R1 setStorePosMode - the reason and the input, refused in words with nothing left behind', () => {
  it('an empty reason, a blank one, and a 201-character one are refused; 200 characters pass', async () => {
    const f = await readyStore('test');
    const before = { row: await posRow(f), audit: await auditCount(f) };
    for (const reason of ['', '   ', 'x'.repeat(201)]) await expectRefusal(set(f, { mode: 'off', reason }), '1 to 200 characters');
    expect({ row: await posRow(f), audit: await auditCount(f) }).toEqual(before);
    await expect(set(f, { mode: 'off', reason: 'x'.repeat(200) })).resolves.toMatchObject({ changed: true });
  });

  it('live with no date, and a mode that is not off, test or live, are refused', async () => {
    const f = await readyStore('test');
    await expectRefusal(set(f, { mode: 'live', liveFrom: undefined }), 'needs the date');
    await expectRefusal(set(f, { mode: 'on' }), 'off, test or live');
    expect((await posRow(f))!.mode).toBe('test');
  });

  it('a store that does not exist in this organisation (or belongs to another) is refused in words, and no row is created for it', async () => {
    const f = await readyStore('test');
    const other = await readyStore('test');
    for (const storeId of [uuid(), other.storeId]) {
      await expectRefusal(set(f, { storeId, mode: 'test' }), /./);
    }
    expect(await posRow(f, other.storeId)).toMatchObject({ mode: 'test' }); // the other org's own row is untouched
    expect((await auditRows(other, 'pos.store_mode_set')).length).toBe(0);
  });
});

describe('R1 setStorePosMode - going live: the date, an existing sales day, the pre-flight', () => {
  it('a date before today is refused; nothing changed', async () => {
    const f = await readyStore('test');
    const before = { row: await posRow(f), audit: await auditCount(f) };
    await expectRefusal(live(f, '2026-11-30'), 'in the past');
    expect({ row: await posRow(f), audit: await auditCount(f) }).toEqual(before);
  });

  it('a sales day (any source) on or after the date is refused with "Switch from the next day."; a sales day BEFORE the date is fine', async () => {
    const f = await readyStore('test');
    await insertDerivedSalesDayRow(sql, { orgId: f.orgId, storeId: f.storeId, businessDate: '2026-12-09', createdBy: f.adminId });
    const before = { row: await posRow(f), audit: await auditCount(f) };
    await expectRefusal(live(f, LIVE_FROM), 'already exists. Switch from the next day.'); // 9 Dec is after 7 Dec
    await expectRefusal(live(f, '2026-12-09'), 'already exists. Switch from the next day.'); // on the date itself
    expect({ row: await posRow(f), audit: await auditCount(f) }).toEqual(before);
    await expect(live(f, '2026-12-10'), 'control: the day before the switch date does not block').resolves.toMatchObject({ changed: true, liveFrom: '2026-12-10' });
  });

  it('a blocking pre-flight item refuses the switch (the stands are gone), names it, and leaves the mode alone; the same store passes once fixed', async () => {
    const f = await readyStore('test');
    await sql`update pos_stands set status = 'retired' where store_id = ${f.storeId}`;
    const before = { row: await posRow(f), audit: await auditCount(f) };
    await expectRefusal(live(f), /pre-flight/i);
    await expectRefusal(live(f), /stands/i);
    expect({ row: await posRow(f), audit: await auditCount(f) }).toEqual(before);
    await sql`update pos_stands set status = 'active' where store_id = ${f.storeId} and number = 7`;
    await expect(live(f)).resolves.toMatchObject({ changed: true, mode: 'live' });
  });

  it('the injected key-file probe is honoured: with the probe saying no, a v1-linked store before 2027 is refused', async () => {
    const f = await readyStore('test');
    await expectRefusal(set(f, { mode: 'live', liveFrom: LIVE_FROM, reason: 'x' }, f.admin, { keyFilePresent: () => false, today: TODAY }), /pre-flight/i);
    expect((await posRow(f))!.mode).toBe('test');
  });

  it('a store must have been in test first: from OFF, or with no pos_stores row, going live is refused with "Switch <store> to test mode first." (not a pre-flight blocker), and the row it began to create is rolled back', async () => {
    const f = await readyStore('off');
    const name = (await sql<{ name: string }[]>`select name from stores where id = ${f.storeId}`)[0]!.name;
    const before = { row: await posRow(f), audit: await auditCount(f) };
    await expectRefusal(live(f), `Switch ${name} to test mode first.`);
    expect({ row: await posRow(f), audit: await auditCount(f) }).toEqual(before);
    // No row at all: same sentence, and no row is left behind.
    expect(await posRow(f, f.store2Id)).toBeUndefined();
    const name2 = (await sql<{ name: string }[]>`select name from stores where id = ${f.store2Id}`)[0]!.name;
    await expectRefusal(set(f, { storeId: f.store2Id, mode: 'live', liveFrom: LIVE_FROM, reason: 'x' }), `Switch ${name2} to test mode first.`);
    expect(await posRow(f, f.store2Id)).toBeUndefined();
    // Control: after test, the same ready store goes live.
    await set(f, { mode: 'test', reason: 'practice first' });
    await expect(live(f)).resolves.toMatchObject({ changed: true, mode: 'live' });
  });
});

describe('R1 setStorePosMode - today is the BUSINESS date (pos.business_day_start_hour), not the calendar date', () => {
  it('at 01:00 Manila on 2 Dec the business day is still 1 Dec: live from 1 Dec is allowed, 30 Nov is in the past', async () => {
    const f = await readyStore('test');
    const at = { keyFilePresent: () => true, now: () => new Date('2026-12-02T01:00:00+08:00') };
    await expectRefusal(set(f, { mode: 'live', liveFrom: '2026-11-30', reason: 'x' }, f.admin, at), 'in the past');
    await expect(set(f, { mode: 'live', liveFrom: '2026-12-01', reason: 'x' }, f.admin, at)).resolves.toMatchObject({ changed: true, liveFrom: '2026-12-01' });
  });
  it('control: at 05:00 Manila on 2 Dec the business day is 2 Dec, so 1 Dec is refused', async () => {
    const f = await readyStore('test');
    const at = { keyFilePresent: () => true, now: () => new Date('2026-12-02T05:00:00+08:00') };
    await expectRefusal(set(f, { mode: 'live', liveFrom: '2026-12-01', reason: 'x' }, f.admin, at), 'in the past');
  });
});

describe('R1 setStorePosMode - two admins at once (the per-store lock the Z uses)', () => {
  it('takes the same advisory lock as the Z: while another transaction holds lockPosDayClose for the store, the switch parks, then completes when it is released', async () => {
    const f = await readyStore('test');
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = asOrg(f.orgId, async (tx) => {
      await advisoryLocksRepo.lockPosDayClose(tx, f.storeId);
      held.resolve();
      await release.promise;
    });
    holder.catch(() => held.resolve());
    const pid = Promise.withResolvers<number>();
    let waiter: Promise<unknown> | undefined;
    let parked = false;
    try {
      await held.promise;
      waiter = asOrg(f.orgId, async (tx) => {
        const rows = (await tx.execute(dsql`select pg_backend_pid() as pid`)) as unknown as { pid: number }[];
        pid.resolve(Number(rows[0]!.pid));
        return setStorePosMode(tx, f.admin, { storeId: f.storeId, mode: 'off', reason: 'queued behind the lock' }, DEPS);
      });
      waiter.catch(() => undefined);
      const waiterPid = await pid.promise;
      const deadline = Date.now() + 15_000;
      while (!parked && Date.now() < deadline) {
        const [w] = await sql<{ n: string }[]>`select count(*)::text n from pg_stat_activity where pid = ${waiterPid} and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        parked = w!.n === '1';
        if (!parked) await new Promise((r) => setTimeout(r, 25));
      }
      expect((await posRow(f))!.mode, 'the switch wrote while the lock was held').toBe('test');
    } finally {
      release.resolve();
    }
    await holder;
    expect(parked, 'the switch never parked on the per-store lock').toBe(true);
    await expect(waiter!).resolves.toMatchObject({ changed: true, mode: 'off' });
  });

  it('two admins racing the FIRST-ever switch of a store (no row yet) both finish with no unique-key error: one changes it, the other finds it already set', async () => {
    const f = await readyStore('test');
    expect(await posRow(f, f.store2Id)).toBeUndefined();
    const one = () => set(f, { storeId: f.store2Id, mode: 'test', reason: 'race' });
    const results = await Promise.all([one(), one()]);
    expect(results.map((r) => r.mode)).toEqual(['test', 'test']);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_stores where store_id = ${f.store2Id}`)[0]!.n).toBe(1);
  });
});

describe('R1 setStorePosMode - the roll-back: only before the first Z on the new POS', () => {
  async function liveStore(): Promise<Fx> {
    const f = await readyStore('live');
    await sql`update pos_stores set live_from = ${LIVE_FROM} where store_id = ${f.storeId}`;
    return f;
  }

  it('with no Z at all, live goes back to off: mode off, live_from cleared, state_version +1, audit before = live with its date', async () => {
    const f = await liveStore();
    const v0 = await stateVersionOf(f);
    await expect(set(f, { mode: 'off', reason: 'tablet printer failed, back to v1' })).resolves.toMatchObject({ changed: true, mode: 'off', liveFrom: null });
    expect(await posRow(f)).toMatchObject({ mode: 'off', live_from: null, state_version: v0 + 1 });
    const audit = await auditRows(f, 'pos.store_mode_set');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toMatchObject({ mode: 'live', liveFrom: LIVE_FROM });
    expect(audit[0]!.after).toMatchObject({ mode: 'off', liveFrom: null, reason: 'tablet printer failed, back to v1' });
  });

  it('live goes back to test too, and a Z dated BEFORE live_from does not stop the roll-back', async () => {
    const f = await liveStore();
    await zOn(f, '2026-12-06');
    await expect(set(f, { mode: 'test', reason: 'back to practice' })).resolves.toMatchObject({ changed: true, mode: 'test', liveFrom: null });
    expect(await posRow(f)).toMatchObject({ mode: 'test', live_from: null });
  });

  it('after a Z on live_from (or any later day) the roll-back is refused with the roll-back sentence; the store stays live and nothing is written', async () => {
    const f = await liveStore();
    await zOn(f, '2026-12-08');
    const before = { row: await posRow(f), audit: await auditCount(f) };
    for (const mode of ['off', 'test']) {
      await expectRefusal(set(f, { mode, reason: 'try to go back' }), 'Days are already closed on the new POS. Roll back from the next day.');
    }
    expect({ row: await posRow(f), audit: await auditCount(f) }).toEqual(before);
    expect((await posRow(f))!.mode).toBe('live');
  });

  it('moving a live store to a different live date is the same decision: allowed before the first Z, refused after it', async () => {
    const f = await liveStore();
    await expect(live(f, '2026-12-14')).resolves.toMatchObject({ changed: true, liveFrom: '2026-12-14' });
    await zOn(f, '2026-12-14');
    await expectRefusal(live(f, '2026-12-20'), 'Days are already closed on the new POS. Roll back from the next day.');
    expect((await posRow(f))!.live_from).toBe('2026-12-14');
  });
});
