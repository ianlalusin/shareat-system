import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-374 S5 (DEF-579 + DEF-584) — whole-number fields REFUSE instead of substituting or dropping.
 * `docs/tasks/374-money-push-follow-ups.md` S5 tests T1-T7, T10, T11 (T8/T9 are the web leg,
 * `apps/erp/tests/integration/t374-s5-expense-line-count.test.ts`).
 *
 * ⛔ TESTER, not BUILDER. Red legs assert the TARGET sentence / row state, never "module missing". Every "no row" assertion
 * has a positive control that writes a row through the same door in the same file.
 *
 * Sentences (all from `parseWholeNumberInput`, `packages/domain/src/shared/whole-number-input.ts`):
 *   blank        `${label} — enter a whole number${unit} from ${min} to ${max}.`
 *   not a number `${label} — "${typed}" is not a whole number${unit} from ${min} to ${max}.`
 * Labels / ranges: allowedShiftStartHours "Allowed shift start hours" 0-23 (the briefing's own example); payoutDays
 * "Payout days" 1-31 (the CHECK `store_attendance_config_payout_days_range_check`); anchorDay "The day" 0-31; asset life
 * "The useful life" 1-1200 " of months" (R9).
 *
 * ⚠️ Label for payout days ("Payout days") is the tester's reading of the page; the range and the quoted token are the load-bearing half.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  createAsset,
  createRecurringTemplate,
  parseShiftDay,
  seedAttendanceConfig,
  supersedeConfig,
  updateAssetTerms,
  updateRecurringTemplate,
} from '@shareat/domain';

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

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED — ${what} was saved instead (the defect this leg targets)`);
}

async function makeOrg(hint: string) {
  const code = uid(`t374s5-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  return { orgId, storeId, mk };
}

// -----------------------------------------------------------------------------------------------
// Attendance config — T1-T4
// -----------------------------------------------------------------------------------------------

async function attendanceStore(hint: string) {
  const { orgId, storeId, mk } = await makeOrg(hint);
  const admin = actor(orgId, await mk('Admin', 'admin'));
  const staff = actor(orgId, await mk('Floor Staff', 'staff'));
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2026-01-01' }));
  return { orgId, storeId, admin, staff };
}
type AttStore = Awaited<ReturnType<typeof attendanceStore>>;

const save = (f: AttStore, changes: Record<string, unknown>, who: Actor = f.admin, effectiveFrom = '2026-06-01') =>
  asOrg(f.orgId, (tx) => supersedeConfig(tx, who, { storeId: f.storeId, effectiveFrom: parseShiftDay(effectiveFrom), changes } as never));

const cfgRows = (storeId: string) =>
  sql<{ id: string; superseded_at: Date | null; allowed: number[]; payout_days: number[] }[]>`
    select id, superseded_at, allowed_shift_start_hours as allowed, payout_days from store_attendance_config where store_id = ${storeId} order by effective_from`;
const liveRow = async (storeId: string) => (await cfgRows(storeId)).find((r) => r.superseded_at === null)!;

const hourSentence = (typed: string) => `Allowed shift start hours — "${typed}" is not a whole number from 0 to 23.`;
const dayTokenSentence = (typed: string) => `Payout days — "${typed}" is not a whole number from 1 to 31.`;

describe('T1 — payoutDays "10, 2O" is refused by the token sentence; no config row', () => {
  it('refuses with the token sentence naming "2O", leaves the live row, writes nothing — red today: parseConfigChanges gets a string', async () => {
    const f = await attendanceStore('t1');
    const before = await cfgRows(f.storeId);
    const refused = await rejection(save(f, { payoutMode: 'fixed_days', payoutDays: '10, 2O' }), 'payout days "10, 2O"');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe(dayTokenSentence('2O'));
    expect((await cfgRows(f.storeId)).map((r) => r.id), 'a refused save changed the config rows').toEqual(before.map((r) => r.id));
  });

  it('positive control: "10, 25" through the same door saves — a new live row carrying [10,25] (so "no row" above could have been a row)', async () => {
    const f = await attendanceStore('t1pc');
    await save(f, { payoutMode: 'fixed_days', payoutDays: '10, 25' });
    expect((await liveRow(f.storeId)).payout_days).toEqual([10, 25]);
    expect(await cfgRows(f.storeId)).toHaveLength(2);
  });
});

describe('T2 — allowedShiftStartHours "9, abc, 14" is refused; no row (the old parseIntList dropped "abc" and saved [9,14])', () => {
  it('names "abc" in the token sentence; the live row keeps the seeded hours', async () => {
    const f = await attendanceStore('t2');
    const before = await cfgRows(f.storeId);
    const refused = await rejection(save(f, { allowedShiftStartHours: '9, abc, 14' }), 'allowed hours "9, abc, 14"');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe(hourSentence('abc'));
    expect((await cfgRows(f.storeId)).map((r) => r.id)).toEqual(before.map((r) => r.id));
  });

  it('hex, exponent and out-of-range tokens are refused too (range 0-23 is the CHECK allowed_hours_check)', async () => {
    const f = await attendanceStore('t2b');
    for (const [typed, bad] of [['9, 0x10', '0x10'], ['9, 1e1', '1e1'], ['9, 24', '24'], ['9, -1', '-1']] as const) {
      const refused = await rejection(save(f, { allowedShiftStartHours: typed }), `allowed hours ${JSON.stringify(typed)}`);
      expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`, `typed ${JSON.stringify(typed)}`).toBe(hourSentence(bad));
    }
    expect(await cfgRows(f.storeId)).toHaveLength(1);
  });

  it('positive control: "9, 14" saves and the live row carries [9,14]', async () => {
    const f = await attendanceStore('t2pc');
    await save(f, { allowedShiftStartHours: '9, 14' });
    expect((await liveRow(f.storeId)).allowed).toEqual([9, 14]);
  });
});

describe('harness control (green on HEAD and after) — a number[] input passes through untouched (✎R6) and writes a row', () => {
  it('payoutDays [10,25] and allowedShiftStartHours [9,14] as arrays save: the "no row" legs above could have been rows', async () => {
    const f = await attendanceStore('hc');
    await save(f, { payoutMode: 'fixed_days', payoutDays: [10, 25], allowedShiftStartHours: [9, 14] });
    const live = await liveRow(f.storeId);
    expect(live.payout_days).toEqual([10, 25]);
    expect(live.allowed).toEqual([9, 14]);
    expect(await cfgRows(f.storeId)).toHaveLength(2);
  });
});

describe('T3 — today\'s accepted shapes keep their byte-identical results (the lib.test.ts cases, moved here)', () => {
  const shapes: [string, number[]][] = [
    ['9, 10,  11', [9, 10, 11]],
    ['14,9,11', [9, 11, 14]],
    ['9,9,10', [9, 10]],
    ['9,,10,', [9, 10]],
    ['9,10,11,14', [9, 10, 11, 14]],
  ];
  for (const [typed, expected] of shapes) {
    it(`allowedShiftStartHours ${JSON.stringify(typed)} -> ${JSON.stringify(expected)} on the live row`, async () => {
      const f = await attendanceStore('t3');
      await save(f, { allowedShiftStartHours: typed });
      expect((await liveRow(f.storeId)).allowed).toEqual(expected);
    });
  }

  it('payoutDays "25 ,10" (spaces, reversed) -> [10,25]', async () => {
    const f = await attendanceStore('t3p');
    await save(f, { payoutMode: 'fixed_days', payoutDays: '25 ,10' });
    expect((await liveRow(f.storeId)).payout_days).toEqual([10, 25]);
  });

  it('a blank hours list is NOT a token refusal — the database CHECK keeps deciding (old: [] -> the CHECK refuses); no row written', async () => {
    const f = await attendanceStore('t3e');
    const refused = await rejection(save(f, { allowedShiftStartHours: '   ' }), 'a blank allowed-hours list');
    expect(refused.userMessage ?? refused.message).not.toMatch(/is not a whole number/);
    expect(await cfgRows(f.storeId)).toHaveLength(1);
  });
});

describe('T4 (I1) — authorize() runs before the parse', () => {
  it('floor staff + payoutDays "abc" -> AuthorizationError, not the token sentence; no row — Mutant: parse before authorize', async () => {
    const f = await attendanceStore('t4');
    const refused = await rejection(save(f, { payoutMode: 'fixed_days', payoutDays: 'abc' }, f.staff), 'a staff save of "abc"');
    expect(refused.err, `got: ${refused.message}`).toBeInstanceOf(AuthorizationError);
    expect(await cfgRows(f.storeId)).toHaveLength(1);
  });

  it('positive control: the same "abc" as an admin IS judged (token sentence), so the staff result above is the gate, not an inert value', async () => {
    const f = await attendanceStore('t4pc');
    const refused = await rejection(save(f, { payoutMode: 'fixed_days', payoutDays: 'abc' }), 'an admin save of "abc"');
    expect(refused.userMessage ?? refused.message).toBe(dayTokenSentence('abc'));
  });
});

// -----------------------------------------------------------------------------------------------
// Recurring templates — T5-T7
// -----------------------------------------------------------------------------------------------

async function recurringStore(hint: string) {
  const { orgId, storeId, mk } = await makeOrg(hint);
  await seedChartOfAccounts(sql, orgId);
  const manager = actor(orgId, await mk('Manager', 'manager'));
  const staff = actor(orgId, await mk('Floor Staff', 'staff'));
  const [category] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code) values (${orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`;
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${orgId}, ${`Landlord ${hint}`}, ${manager.personId}) returning id`;
  return { orgId, storeId, manager, staff, categoryId: category!.id, supplierId: supplier!.id };
}
type RecStore = Awaited<ReturnType<typeof recurringStore>>;

const tmplBase = (f: RecStore) => ({
  storeId: f.storeId, name: 'Rent', categoryId: f.categoryId, supplierId: f.supplierId, defaultAmount: '25000.00',
});
const create = (f: RecStore, interval: 'weekly' | 'monthly', anchorDay: unknown) =>
  asOrg(f.orgId, (tx) => createRecurringTemplate(tx, f.manager, { ...tmplBase(f), interval, anchorDay } as never));
const templates = (storeId: string) =>
  sql<{ id: string; anchor_day: number; interval: string }[]>`select id, anchor_day, interval from recurring_expenses where store_id = ${storeId} order by created_at`;

describe('T5 — a weekly template with a blank / hex / exponent day is refused; no template', () => {
  it('"" -> "The day — enter a whole number from 0 to 31." (HEAD, via the action\'s Number(\'\'): a Sunday template)', async () => {
    const f = await recurringStore('t5');
    const refused = await rejection(create(f, 'weekly', ''), 'a blank anchor day');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe('The day — enter a whole number from 0 to 31.');
    expect(await templates(f.storeId)).toHaveLength(0);
  });

  it('"0x5" and "1e1" -> the not-a-whole-number sentence naming what was typed; no template', async () => {
    const f = await recurringStore('t5b');
    for (const typed of ['0x5', '1e1']) {
      const refused = await rejection(create(f, 'weekly', typed), `anchor day ${typed}`);
      expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`, `typed ${typed}`).toBe(`The day — "${typed}" is not a whole number from 0 to 31.`);
    }
    expect(await templates(f.storeId)).toHaveLength(0);
  });

  it('positive control: weekly 3 (a number, accepted today and after) through the same door creates a row (so the zero counts above could have been one)', async () => {
    const f = await recurringStore('t5pc');
    await create(f, 'weekly', 3);
    expect(await templates(f.storeId)).toHaveLength(1);
  });
});

describe('T6 (control) — accepted days keep their meaning', () => {
  it('numbers (green on HEAD and after): weekly 0 is Sunday, monthly 31 kept', async () => {
    const f = await recurringStore('t6n');
    await create(f, 'weekly', 0);
    await create(f, 'monthly', 31);
    expect((await templates(f.storeId)).map((r) => [r.interval, r.anchor_day])).toEqual([['weekly', 0], ['monthly', 31]]);
  });

  it('weekly "0" is Sunday (a TYPED zero stays valid; only a blank is refused); monthly "31" is kept', async () => {
    const f = await recurringStore('t6');
    await create(f, 'weekly', '0');
    await create(f, 'monthly', '31');
    const rows = await templates(f.storeId);
    expect(rows.map((r) => [r.interval, r.anchor_day])).toEqual([['weekly', 0], ['monthly', 31]]);
  });
});

describe('T7 — updateRecurringTemplate', () => {
  it('without anchorDay the stored day is unchanged (an omitted key stays omitted, never Number(undefined))', async () => {
    const f = await recurringStore('t7');
    const { id } = (await create(f, 'monthly', 5)) as { id: string };
    await asOrg(f.orgId, (tx) => updateRecurringTemplate(tx, f.manager, { templateId: id, name: 'Rent (renamed)' } as never));
    const [row] = await sql<{ anchor_day: number; name: string }[]>`select anchor_day, name from recurring_expenses where id = ${id}`;
    expect(row).toMatchObject({ anchor_day: 5, name: 'Rent (renamed)' });
  });

  it('anchorDay "" is refused by the sentence; the stored day is unchanged — and "7" (a valid supplied day) DOES update, so "unchanged" is not an inert path', async () => {
    const f = await recurringStore('t7b');
    const { id } = (await create(f, 'monthly', 5)) as { id: string };
    const refused = await rejection(
      asOrg(f.orgId, (tx) => updateRecurringTemplate(tx, f.manager, { templateId: id, anchorDay: '' } as never)),
      'a blank anchor day on update',
    );
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe('The day — enter a whole number from 0 to 31.');
    expect((await sql<{ anchor_day: number }[]>`select anchor_day from recurring_expenses where id = ${id}`)[0]!.anchor_day).toBe(5);

    await asOrg(f.orgId, (tx) => updateRecurringTemplate(tx, f.manager, { templateId: id, anchorDay: '7' } as never));
    expect((await sql<{ anchor_day: number }[]>`select anchor_day from recurring_expenses where id = ${id}`)[0]!.anchor_day).toBe(7);
  });
});

// -----------------------------------------------------------------------------------------------
// Fixed assets — T10 / T11 (DEF-584, ✎R9)
// -----------------------------------------------------------------------------------------------

async function assetStore(hint: string) {
  const { orgId, storeId, mk } = await makeOrg(hint);
  await seedChartOfAccounts(sql, orgId);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')`;
  }
  const admin = actor(orgId, await mk('Admin', 'admin'));
  const staff = actor(orgId, await mk('Floor Staff', 'staff'));
  return { orgId, storeId, admin, staff };
}
type AssetStore = Awaited<ReturnType<typeof assetStore>>;

const makeAsset = (f: AssetStore, usefulLifeMonths: unknown, name = 'Chest freezer') =>
  asOrg(f.orgId, (tx) =>
    createAsset(tx, f.admin, {
      storeId: f.storeId, name, category: 'appliances', acquiredOn: '2026-01-15', cost: '120000.00', usefulLifeMonths,
    } as never),
  );
const assetRows = (storeId: string) =>
  sql<{ id: string; life: number }[]>`select id, useful_life_months as life from fixed_assets where store_id = ${storeId} order by created_at`;
const LIFE_SENTENCE = (typed: string) => `The useful life — "${typed}" is not a whole number of months from 1 to 1200.`;

describe('T10 — createAsset / updateAssetTerms refuse a hex or exponent useful life (DEF-584)', () => {
  it('createAsset "0x10", "1e1" and "1201" (over the 1200 ceiling) -> the sentence naming what was typed; no asset row', async () => {
    const f = await assetStore('t10c');
    for (const typed of ['0x10', '1e1', '1201']) {
      const refused = await rejection(makeAsset(f, typed), `createAsset life ${typed}`);
      expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`, `typed ${typed}`).toBe(LIFE_SENTENCE(typed));
    }
    expect(await assetRows(f.storeId)).toHaveLength(0);
  });

  it('updateAssetTerms "0x10" -> refused with the sentence; the asset keeps its 24 months — red today: Number("0x10") = 16 is saved', async () => {
    const f = await assetStore('t10u');
    const { id } = (await makeAsset(f, 24)) as { id: string };
    const input = { name: 'Chest freezer', category: 'appliances', interval: 'monthly', salvageValue: null, notes: null };
    const refused = await rejection(
      asOrg(f.orgId, (tx) => updateAssetTerms(tx, f.admin, id, { ...input, usefulLifeMonths: '0x10' })),
      'updateAssetTerms life 0x10',
    );
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe(LIFE_SENTENCE('0x10'));
    expect((await assetRows(f.storeId))[0]!.life).toBe(24);
  });
});

describe('T11 (controls) — the spellings that must keep working', () => {
  it('createAsset "16" -> a 16-month asset (a string, as the form now posts it)', async () => {
    const f = await assetStore('t11a');
    await makeAsset(f, '16');
    expect((await assetRows(f.storeId)).map((r) => r.life)).toEqual([16]);
  });

  it("createAsset '1200' (the ceiling itself) -> a 1200-month asset: the positive control beside the '1201' refusal", async () => {
    const f = await assetStore('t11ceil');
    await makeAsset(f, '1200');
    expect((await assetRows(f.storeId)).map((r) => r.life)).toEqual([1200]);
  });

  it('createAsset with a blank (null) life -> the category default, the same life an omitted value gets', async () => {
    const f = await assetStore('t11b');
    await makeAsset(f, null, 'Blank life');
    await makeAsset(f, undefined, 'Omitted life');
    const lives = (await assetRows(f.storeId)).map((r) => r.life);
    expect(lives).toHaveLength(2);
    expect(lives[0]).toBe(lives[1]);
    expect(lives[0]).toBeGreaterThan(0);
  });

  it('updateAssetTerms "016" -> 16 (leading zeros are digits, not octal)', async () => {
    const f = await assetStore('t11c');
    const { id } = (await makeAsset(f, 24)) as { id: string };
    await asOrg(f.orgId, (tx) =>
      updateAssetTerms(tx, f.admin, id, { name: 'Chest freezer', category: 'appliances', usefulLifeMonths: '016', interval: 'monthly', salvageValue: null, notes: null }),
    );
    expect((await assetRows(f.storeId))[0]!.life).toBe(16);
  });
});

// -----------------------------------------------------------------------------------------------
// F5 — authorize() before the parse at the three other sites (same shape as T4); F2 — a NUMBER life obeys the ceiling too
// -----------------------------------------------------------------------------------------------

describe('F5 — an actor without the permission gets AuthorizationError, never the parse sentence', () => {
  it('createRecurringTemplate: staff + anchorDay "abc" -> AuthorizationError; no template; control: the manager IS judged (the day sentence)', async () => {
    const f = await recurringStore('f5r');
    const denied = await rejection(asOrg(f.orgId, (tx) => createRecurringTemplate(tx, f.staff, { ...tmplBase(f), interval: 'weekly', anchorDay: 'abc' } as never)), 'staff recurring create');
    expect(denied.err, `got: ${denied.message}`).toBeInstanceOf(AuthorizationError);
    expect(await templates(f.storeId)).toHaveLength(0);
    const judged = await rejection(create(f, 'weekly', 'abc'), 'manager recurring create "abc"');
    expect(judged.userMessage ?? judged.message).toBe('The day — "abc" is not a whole number from 0 to 31.');
  });

  it('createAsset: staff + "0x10" -> AuthorizationError; no asset; control: the admin IS judged', async () => {
    const f = await assetStore('f5c');
    const denied = await rejection(
      asOrg(f.orgId, (tx) => createAsset(tx, f.staff, { storeId: f.storeId, name: 'X', category: 'appliances', acquiredOn: '2026-01-15', cost: '120000.00', usefulLifeMonths: '0x10' } as never)),
      'staff createAsset',
    );
    expect(denied.err, `got: ${denied.message}`).toBeInstanceOf(AuthorizationError);
    expect(await assetRows(f.storeId)).toHaveLength(0);
    const judged = await rejection(makeAsset(f, '0x10'), 'admin createAsset "0x10"');
    expect(judged.userMessage ?? judged.message).toBe(LIFE_SENTENCE('0x10'));
  });

  it('updateAssetTerms: staff + "0x10" -> AuthorizationError; life unchanged; control: the admin IS judged', async () => {
    const f = await assetStore('f5u');
    const { id } = (await makeAsset(f, 24)) as { id: string };
    const input = { name: 'Chest freezer', category: 'appliances', usefulLifeMonths: '0x10', interval: 'monthly', salvageValue: null, notes: null };
    const denied = await rejection(asOrg(f.orgId, (tx) => updateAssetTerms(tx, f.staff, id, input)), 'staff updateAssetTerms');
    expect(denied.err, `got: ${denied.message}`).toBeInstanceOf(AuthorizationError);
    expect((await assetRows(f.storeId))[0]!.life).toBe(24);
    const judged = await rejection(asOrg(f.orgId, (tx) => updateAssetTerms(tx, f.admin, id, input)), 'admin updateAssetTerms "0x10"');
    expect(judged.userMessage ?? judged.message).toBe(LIFE_SENTENCE('0x10'));
  });
});

describe('F2 — createAsset with a NUMBER life obeys the 1200 ceiling', () => {
  it('number 5000 -> refused (the whole-number sentence for 1 to 1200); no asset row', async () => {
    const f = await assetStore('f2a');
    const refused = await rejection(makeAsset(f, 5000), 'createAsset life 5000 (number)');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe(LIFE_SENTENCE('5000'));
    expect(await assetRows(f.storeId)).toHaveLength(0);
  });

  it('control: number 1200 -> a 1200-month asset (a number, as other callers pass it)', async () => {
    const f = await assetStore('f2b');
    await makeAsset(f, 1200);
    expect((await assetRows(f.storeId)).map((r) => r.life)).toEqual([1200]);
  });
});
