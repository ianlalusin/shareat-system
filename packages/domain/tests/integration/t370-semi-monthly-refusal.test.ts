import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-370 S3 (DEF-409) — a semi-monthly pay cycle that cannot pay at intervals of 16 days or fewer is REFUSED ON SAVE.
 * `docs/tasks/370-owner-cap-dates.md` R6-R9 and tests S1-S7, D1, D2. (Ian, 2026-09-30: "refuse on save: semi-monthly
 * needs exactly two pay days ≤16 days apart.")
 *
 * ⛔ TESTER, not BUILDER. Red legs assert the TARGET: the EXACT sentence (R9), the live row unchanged and no new row.
 * Every refusal has a positive control that saves. The DB half (D1/D2) goes through raw inserts and asserts the
 * constraint by its NAME, `store_attendance_config_semi_monthly_two_days_check` — never by the migration's file name.
 *
 * The two sentences (R9), exactly:
 *   SEMI_MONTHLY_TWO_DAYS = "A semi-monthly store pays on exactly two different days of the month. Enter two payout days, for example 10,25."
 *   semiMonthlyGap(n)     = "This semi-monthly pay cycle can run ${n} days between paydays. The Labor Code (Art. 103) allows at most 16.
 *                            Change the payout days or the cutoff day, for example payout days 10,25 with cutoff 15."
 * (single-spaced; the spec wraps them across lines.)
 *
 * Not written here: the sibling suites the spec lists elsewhere — P1 (the unit table, t370-max-payout-gap.test.ts), W1/W2 (the
 * web legs), the new constraint-message row, and the t332 fixture change.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { listFindings, parseShiftDay, seedAttendanceConfig, supersedeConfig } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
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

const TWO_DAYS = 'A semi-monthly store pays on exactly two different days of the month. Enter two payout days, for example 10,25.';
const gapSentence = (n: number) =>
  `This semi-monthly pay cycle can run ${n} days between paydays. The Labor Code (Art. 103) allows at most 16. ` +
  'Change the payout days or the cutoff day, for example payout days 10,25 with cutoff 15.';

/** An org and a store with NO config row yet (D1/D2/S7 insert raw rows), an admin (manage_store_settings) and floor staff. */
async function bare(hint: string) {
  const code = uid(`t370s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const staffId = await mk('Floor Staff', 'staff');
  return { orgId, storeId, admin: actor(orgId, adminId), staff: actor(orgId, staffId) };
}
/** A store seeded with the schema defaults (semi_monthly, lag 0, cutoff 15) — which comply. */
async function seeded(hint: string) {
  const f = await bare(hint);
  await asOrg(f.orgId, (tx) => seedAttendanceConfig(tx, { orgId: f.orgId, storeId: f.storeId, effectiveFrom: '2026-01-01' }));
  return f;
}
type Store = Awaited<ReturnType<typeof bare>>;

const save = (f: Store, changes: Record<string, unknown>, effectiveFrom = '2026-06-01') =>
  asOrg(f.orgId, (tx) => supersedeConfig(tx, f.admin, { storeId: f.storeId, effectiveFrom: parseShiftDay(effectiveFrom), changes } as never));

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED — ${what} was saved instead (the defect this leg targets)`);
}
const rows = (storeId: string) => sql<{ id: string; superseded_at: Date | null; payout_mode: string; payout_days: number[]; semi_monthly_cutoff_day: number; late_grace_minutes: number }[]>`
  select id, superseded_at, payout_mode, payout_days, semi_monthly_cutoff_day, late_grace_minutes from store_attendance_config where store_id = ${storeId} order by effective_from`;
const live = async (storeId: string) => (await rows(storeId)).filter((r) => r.superseded_at === null);

/** The refusal must leave the store exactly as it was: same live row id, same row count. */
async function expectUntouched(f: Store, before: { id: string }[]) {
  const after = await rows(f.storeId);
  expect(after.map((r) => r.id), 'a refused save changed the store config rows').toEqual(before.map((r) => r.id));
  expect(after.filter((r) => r.superseded_at === null)).toHaveLength(1);
}

// -----------------------------------------------------------------------------------------------
// S1 — one pay day
// -----------------------------------------------------------------------------------------------

describe('S1 — semi_monthly + fixed_days + a single pay day is refused', () => {
  it('payoutDays [10] -> userMessage === SEMI_MONTHLY_TWO_DAYS exactly; the live row is unchanged and no row was written — Mutant: remove the count check (the gap check would then say the gap sentence instead)', async () => {
    const f = await seeded('s1');
    const before = await rows(f.storeId);
    const refused = await rejection(save(f, { payoutMode: 'fixed_days', payoutDays: [10] }), 'a semi-monthly store with ONE pay day');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe(TWO_DAYS);
    await expectUntouched(f, before);
  });

  it('positive control: [10,25] saves (a new live row; the old one superseded)', async () => {
    const f = await seeded('s1pc');
    await save(f, { payoutMode: 'fixed_days', payoutDays: [10, 25] });
    const l = await live(f.storeId);
    expect(l).toHaveLength(1);
    expect(l[0]!.payout_days).toEqual([10, 25]);
    expect((await rows(f.storeId)).length).toBe(2);
  });
});

describe('S2 — two days that are the same day', () => {
  it('payoutDays [10,10], passed directly (bypassing the form\'s de-duplicating parseIntList) -> the same SEMI_MONTHLY_TWO_DAYS sentence — Mutant: check cardinality only, not distinctness', async () => {
    const f = await seeded('s2');
    const before = await rows(f.storeId);
    const refused = await rejection(save(f, { payoutMode: 'fixed_days', payoutDays: [10, 10] }), 'a semi-monthly store whose two pay days are the same day');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe(TWO_DAYS);
    await expectUntouched(f, before);
  });
});

// -----------------------------------------------------------------------------------------------
// S3 / S4 — the 16-day ceiling
// -----------------------------------------------------------------------------------------------

describe('S3 — the gap must be ≤ 16', () => {
  it('payoutDays [10,27] (cutoff 15) -> semiMonthlyGap(17); nothing written — Mutant: `<` instead of `≤` against 16 would also refuse [10,25] (16): see the controls in S6', async () => {
    const f = await seeded('s3');
    const before = await rows(f.storeId);
    const refused = await rejection(save(f, { payoutMode: 'fixed_days', payoutDays: [10, 27] }), 'a semi-monthly cycle that runs 17 days between paydays');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe(gapSentence(17));
    await expectUntouched(f, before);
  });
});

describe('S4 — the rule applies to LAG mode too (R7)', () => {
  it('lag mode, cutoff 10 -> semiMonthlyGap(21); nothing written — Mutant: gate the gap check on fixed_days only', async () => {
    const f = await seeded('s4');
    const before = await rows(f.storeId);
    const refused = await rejection(save(f, { payoutMode: 'lag', semiMonthlyCutoffDay: 10 }), 'a semi-monthly lag store with cutoff 10');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe(gapSentence(21));
    await expectUntouched(f, before);
  });
});

// -----------------------------------------------------------------------------------------------
// S5 — judged on the MERGED row
// -----------------------------------------------------------------------------------------------

describe('S5 — the rule is judged on the merged row, not on `changes`', () => {
  it('live row: monthly + fixed_days [10,25]; a change of ONLY payrollPeriodType: semi_monthly with payoutDays [10] -> refused; the merged row (semi_monthly, fixed_days, [10]) is what is judged — Mutant: validate `changes` instead of the merged row', async () => {
    const f = await seeded('s5');
    await save(f, { payrollPeriodType: 'monthly', payoutMode: 'fixed_days', payoutDays: [10, 25] }, '2026-03-01'); // out of the rule: saves
    const before = await rows(f.storeId);

    const refused = await rejection(save(f, { payrollPeriodType: 'semi_monthly', payoutDays: [10] }, '2026-06-01'), 'a switch to semi-monthly that leaves one pay day');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe(TWO_DAYS);
    await expectUntouched(f, before);
  });

  it('positive control: the same change with payoutDays [10,25] saves', async () => {
    const f = await seeded('s5pc');
    await save(f, { payrollPeriodType: 'monthly', payoutMode: 'fixed_days', payoutDays: [10, 25] }, '2026-03-01');
    await save(f, { payrollPeriodType: 'semi_monthly', payoutDays: [10, 25] }, '2026-06-01');
    expect((await live(f.storeId))[0]!.payout_days).toEqual([10, 25]);
  });
});

// -----------------------------------------------------------------------------------------------
// S6 — the controls: nothing compliant is refused
// -----------------------------------------------------------------------------------------------

describe('S6 (controls) — every compliant cadence still saves; monthly is outside the rule', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['fixed [10,25]', { payoutMode: 'fixed_days', payoutDays: [10, 25] }],
    ['fixed [5,20]', { payoutMode: 'fixed_days', payoutDays: [5, 20] }],
    ['fixed [16,31]', { payoutMode: 'fixed_days', payoutDays: [16, 31] }],
    // T-370 A3 (Ian, 2026-10-01): 15/30 is SUPPORTED - the second half pays on the 30th (S3b), so the worst gap is 16.
    // Red until S3b lands: with the old payoutDateFor the Jan/Mar second halves roll to the NEXT month's 30th (gap 31).
    ['fixed [15,30] (A3: ruled supported)', { payoutMode: 'fixed_days', payoutDays: [15, 30] }],
    ['lag, cutoff 15', { payoutMode: 'lag', semiMonthlyCutoffDay: 15 }],
    ['monthly + fixed [10] (out of the rule)', { payrollPeriodType: 'monthly', payoutMode: 'fixed_days', payoutDays: [10] }],
  ];
  for (const [name, changes] of cases) {
    it(`${name} saves — any over-refusal is red`, async () => {
      const f = await seeded(`s6-${name.replace(/\W+/g, '')}`);
      await save(f, changes);
      expect(await live(f.storeId)).toHaveLength(1);
      expect((await rows(f.storeId)).length).toBe(2);
    });
  }
});

// -----------------------------------------------------------------------------------------------
// S7 — an already-out-of-line store is refused on ANY save until its cadence is fixed
// -----------------------------------------------------------------------------------------------

describe('S7 — a live row that violates the spacing rule is refused on an UNRELATED save (R7)', () => {
  /** lag + cutoff 10 is ALLOWED by the DB CHECK (the CHECK only covers fixed_days), so it can exist as a raw live row. */
  async function outOfLine(hint: string) {
    const f = await bare(hint);
    await sql`insert into store_attendance_config (org_id, store_id, effective_from, payroll_period_type, semi_monthly_cutoff_day, payout_mode)
              values (${f.orgId}, ${f.storeId}, '2026-01-01', 'semi_monthly', 10, 'lag')`;
    return f;
  }

  it('changing only lateGraceMinutes -> semiMonthlyGap(21); nothing written — Mutant: judge only the changed fields', async () => {
    const f = await outOfLine('s7');
    const before = await rows(f.storeId);
    const refused = await rejection(save(f, { lateGraceMinutes: 5 }), 'a save that leaves a 21-day cycle in place');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toBe(gapSentence(21));
    await expectUntouched(f, before);
  });

  it('S7c (control): the same store and save PLUS semiMonthlyCutoffDay: 15 saves, and the grace change lands', async () => {
    const f = await outOfLine('s7c');
    await save(f, { lateGraceMinutes: 5, semiMonthlyCutoffDay: 15 });
    const l = await live(f.storeId);
    expect(l).toHaveLength(1);
    expect(l[0]!.semi_monthly_cutoff_day).toBe(15);
    expect(l[0]!.late_grace_minutes).toBe(5);
  });
});

// -----------------------------------------------------------------------------------------------
// Invariant 6 — what the domain accepts, the T-332 detector never fires on
// -----------------------------------------------------------------------------------------------

describe('Invariant 6 — a config supersedeConfig accepts never fires payoutIntervalTooLong', () => {
  it('after saving [10,25] and cutoff-15 lag the store has no payoutIntervalTooLong finding (positive control: a raw-inserted monthly store DOES)', async () => {
    const accepted = await seeded('inv6');
    await save(accepted, { payoutMode: 'fixed_days', payoutDays: [10, 25] });

    const violating = await bare('inv6v');
    await sql`insert into store_attendance_config (org_id, store_id, effective_from, payroll_period_type, semi_monthly_cutoff_day, payout_mode)
              values (${violating.orgId}, ${violating.storeId}, '2026-01-01', 'monthly', 15, 'lag')`;

    const kinds = async (f: Store) =>
      (await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-05' } as never))).findings
        .filter((x) => x.storeId === f.storeId)
        .map((x) => x.kind);
    expect(await kinds(violating), 'control: the detector fires on a 31-day monthly cycle').toContain('payoutIntervalTooLong');
    expect(await kinds(accepted)).not.toContain('payoutIntervalTooLong');
  });

  it('a live [15,30] store (A3: accepted on save) raises no payoutIntervalTooLong either - the detector and the save rule read one gap (control: the violating monthly store still does)', async () => {
    const accepted = await seeded('inv6-1530');
    await save(accepted, { payoutMode: 'fixed_days', payoutDays: [15, 30] });
    const violating = await bare('inv6v-1530');
    await sql`insert into store_attendance_config (org_id, store_id, effective_from, payroll_period_type, semi_monthly_cutoff_day, payout_mode)
              values (${violating.orgId}, ${violating.storeId}, '2026-01-01', 'monthly', 15, 'lag')`;
    const kinds = async (f: Store) =>
      (await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-05' } as never))).findings
        .filter((x) => x.storeId === f.storeId)
        .map((x) => x.kind);
    expect(await kinds(violating), 'control: the detector fires on a 31-day monthly cycle').toContain('payoutIntervalTooLong');
    expect(await kinds(accepted), 'a ruled-supported 15/30 store was flagged as paying too rarely').not.toContain('payoutIntervalTooLong');
  });
});

// -----------------------------------------------------------------------------------------------
// N1 / N2 — Amendment A4: the verdict must not depend on the effectiveFrom the save happens to carry
// -----------------------------------------------------------------------------------------------

/** Raw live row with the given cadence (the shape `supersedeConfig` would have written), for the detector half. */
async function rawLive(f: Store, cutoff: number, days: number[]) {
  await sql`insert into store_attendance_config (org_id, store_id, effective_from, payroll_period_type, semi_monthly_cutoff_day, payout_mode, payout_days)
            values (${f.orgId}, ${f.storeId}, '2026-01-01', 'semi_monthly', ${cutoff}, 'fixed_days', ${sql.array(days)}::integer[])`;
}
const findingsOf = async (f: Store) =>
  (await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-05' } as never))).findings.filter((x) => x.storeId === f.storeId);

describe('N1 — cutoff 10 with [10,25] is legal (its true worst gap is 16) and saves at EVERY effectiveFrom, including the starts the 12-month window got wrong', () => {
  // The auditor's failing starts: the month before a 12-month window pays its second period INTO the window but was never generated, so
  // cutoff 10 + [10,25] measured 31 from 2026-10, 2027-01 and 2027-03. One store per month: each is seeded 2026-01-01, so the 15th is after it.
  for (const effectiveFrom of ['2026-10-15', '2027-01-15', '2027-03-15']) {
    it(`effectiveFrom ${effectiveFrom}: the save is accepted (a legal store was refused when the gap depended on the start) — Mutant: generate paydays from the frame's first month only, or restore a start-dependent window`, async () => {
      const f = await seeded(`n1-${effectiveFrom}`);
      await save(f, { semiMonthlyCutoffDay: 10, payoutMode: 'fixed_days', payoutDays: [10, 25] }, effectiveFrom);
      const l = await live(f.storeId);
      expect(l).toHaveLength(1);
      expect(l[0]!.semi_monthly_cutoff_day).toBe(10);
      expect(l[0]!.payout_days).toEqual([10, 25]);
      expect((await rows(f.storeId)).length, 'the save did not supersede and insert').toBe(2);
    });
  }

  it('the detector agrees: a live cutoff-10 [10,25] row raises no payoutIntervalTooLong (control: a live monthly store still does)', async () => {
    const legal = await bare('n1-det');
    await rawLive(legal, 10, [10, 25]);
    const violating = await bare('n1-detv');
    await sql`insert into store_attendance_config (org_id, store_id, effective_from, payroll_period_type, semi_monthly_cutoff_day, payout_mode)
              values (${violating.orgId}, ${violating.storeId}, '2026-01-01', 'monthly', 15, 'lag')`;
    expect((await findingsOf(violating)).map((x) => x.kind), 'control: the detector fires on a 31-day monthly cycle').toContain('payoutIntervalTooLong');
    expect((await findingsOf(legal)).map((x) => x.kind), 'a legal store was flagged').not.toContain('payoutIntervalTooLong');
  });
});

describe('N2 — cutoff 15 with [13,29] runs 31 days and is refused with the gap sentence at EVERY effectiveFrom 2026-01 .. 2028-12, including a window whose only February is the leap one', () => {
  it('36 saves (the 15th of each month) on one store: every one refused with semiMonthlyGap(31), the store unchanged afterwards — Mutant: a frame that loses the non-leap February collision (the 2027-03-15 save would succeed)', async () => {
    const f = await seeded('n2');
    const before = await rows(f.storeId);
    const accepted: string[] = [];
    const wrong: string[] = [];
    for (let y = 2026; y <= 2028; y++) {
      for (let m = 1; m <= 12; m++) {
        const day = `${y}-${String(m).padStart(2, '0')}-15`;
        try {
          await save(f, { payoutMode: 'fixed_days', payoutDays: [13, 29] }, day);
          accepted.push(day);
        } catch (err) {
          const said = (err as { userMessage?: string }).userMessage ?? `NO userMessage — raw: ${(err as Error).message}`;
          if (said !== gapSentence(31)) wrong.push(`${day}: ${said}`);
        }
      }
    }
    expect(accepted, 'a 31-day cycle was SAVED at these effectiveFrom dates').toEqual([]);
    expect(wrong, 'refused, but not with the semiMonthlyGap(31) sentence').toEqual([]);
    await expectUntouched(f, before);
    expect((await rows(f.storeId)).length).toBe(before.length);
  });

  it('the detector agrees: a live cutoff-15 [13,29] row raises payoutIntervalTooLong with 31 in its detail', async () => {
    const f = await bare('n2-det');
    await rawLive(f, 15, [13, 29]);
    const flagged = (await findingsOf(f)).find((x) => x.kind === 'payoutIntervalTooLong');
    expect(flagged, 'a store that runs 31 days between paydays was not flagged').toBeDefined();
    expect(JSON.stringify(flagged), 'the finding does not name 31 days').toMatch(/\b31\b/);
  });
});

// -----------------------------------------------------------------------------------------------
// Who may save, and in what order
// -----------------------------------------------------------------------------------------------

describe('Authorisation comes first', () => {
  it('floor staff saving a non-compliant cycle get AuthorizationError — not the cadence sentence (T-352 rule); the admin gets the sentence', async () => {
    const f = await seeded('auth');
    const staffRefused = await rejection(asOrg(f.orgId, (tx) => supersedeConfig(tx, f.staff, { storeId: f.storeId, effectiveFrom: parseShiftDay('2026-06-01'), changes: { payoutMode: 'fixed_days', payoutDays: [10] } } as never)), 'a staff save');
    expect(staffRefused.err).toBeInstanceOf(AuthorizationError);
    const adminRefused = await rejection(save(f, { payoutMode: 'fixed_days', payoutDays: [10] }), 'an admin save of one pay day');
    expect(adminRefused.userMessage).toBe(TWO_DAYS);
  });
});

// -----------------------------------------------------------------------------------------------
// D1 / D2 — the database CHECK (R6)
// -----------------------------------------------------------------------------------------------

describe('D1 — the CHECK refuses a LIVE semi_monthly + fixed_days row without exactly two distinct days', () => {
  const insertLive = (f: Store, days: string, extra = '') =>
    sql.unsafe(
      `insert into store_attendance_config (org_id, store_id, effective_from, payroll_period_type, semi_monthly_cutoff_day, payout_mode, payout_days${extra ? ', ' + extra.split('=')[0] : ''})
       values ('${f.orgId}', '${f.storeId}', '2026-01-01', 'semi_monthly', 15, 'fixed_days', ${days}${extra ? ', ' + extra.split('=')[1] : ''})`,
    );

  for (const [label, days] of [['ARRAY[10]', 'ARRAY[10]::integer[]'], ['ARRAY[10,NULL] (a NULL slips through a bare CHECK)', 'ARRAY[10,NULL]::integer[]'], ['ARRAY[10,10]', 'ARRAY[10,10]::integer[]']] as const) {
    it(`a live row with payout_days = ${label} -> 23514 on store_attendance_config_semi_monthly_two_days_check — Mutant: drop the CHECK`, async () => {
      const f = await bare(`d1-${label.slice(0, 12).replace(/\W+/g, '')}`);
      await expect(insertLive(f, days)).rejects.toMatchObject({ code: '23514', constraint_name: 'store_attendance_config_semi_monthly_two_days_check' });
      expect(await rows(f.storeId)).toHaveLength(0);
    });
  }

  it('positive control: payout_days = ARRAY[10,25] inserts', async () => {
    const f = await bare('d1-ok');
    await insertLive(f, 'ARRAY[10,25]::integer[]');
    expect(await live(f.storeId)).toHaveLength(1);
  });
});

describe('D2 (controls) — the CHECK exempts history and does not swallow its neighbours', () => {
  it('the same one-day row with superseded_at SET inserts (history is never rewritten)', async () => {
    const f = await bare('d2-hist');
    await sql`insert into store_attendance_config (org_id, store_id, effective_from, payroll_period_type, semi_monthly_cutoff_day, payout_mode, payout_days, superseded_at)
              values (${f.orgId}, ${f.storeId}, '2026-01-01', 'semi_monthly', 15, 'fixed_days', ${sql.array([10])}::integer[], now())`;
    expect(await rows(f.storeId)).toHaveLength(1);
  });

  it('a bogus payout_mode still reports payout_mode_check (not the new check), and fixed_days with NO days still reports fixed_days_needed_check', async () => {
    const f = await bare('d2-iso');
    await expect(
      sql`insert into store_attendance_config (org_id, store_id, effective_from, payroll_period_type, semi_monthly_cutoff_day, payout_mode, payout_days)
          values (${f.orgId}, ${f.storeId}, '2026-01-01', 'semi_monthly', 15, 'bogus', ${sql.array([15])}::integer[])`,
    ).rejects.toMatchObject({ constraint_name: 'store_attendance_config_payout_mode_check' });
    await expect(
      sql`insert into store_attendance_config (org_id, store_id, effective_from, payroll_period_type, semi_monthly_cutoff_day, payout_mode)
          values (${f.orgId}, ${f.storeId}, '2026-02-01', 'semi_monthly', 15, 'fixed_days')`,
    ).rejects.toMatchObject({ constraint_name: 'store_attendance_config_fixed_days_needed_check' });
  });
});
