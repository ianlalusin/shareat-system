import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-155 Part B — attendance config, effective-dated.
 * `docs/tasks/155-shift-day-and-attendance-config.md`.
 *
 * ⭐ Invariant 6 is the one that matters most: reading the same day before and after a policy change
 * returns DIFFERENT answers, and the historical one is unchanged. Everything else here exists to
 * stop that answer being quietly editable.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  getConfigForShiftDay,
  getLiveConfig,
  parseShiftDay,
  seedAttendanceConfig,
  supersedeConfig,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`ac-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;

  const seeded = await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }),
  );

  return { orgId, storeId: store!.id, admin: actor(orgId, admin!.id), seeded };
}

// -------------------------------------------------------------------------------------

describe('T-155 invariant 7 — every column is NOT NULL, so a store cannot be half-configured', () => {
  it('the seeded row carries every v1 default, read from the source not chosen here', async () => {
    const f = await fixture('defaults');
    const c = f.seeded;
    expect(Number(c.requiredHoursPerShift)).toBe(9);
    expect(Number(c.halfDayHours)).toBe(5);
    expect(c.shortShiftHalfDayOt).toBe(false);
    expect(c.allowedShiftStartHours).toEqual([9, 10, 11, 14, 15, 16, 17, 18]);
    expect(c.timeMode).toBe('open');
    expect(c.nightDiffEnabled).toBe(true);
    expect(c.nightDiffStartHour).toBe(22);
    expect(c.nightDiffEndHour).toBe(6);
    expect(Number(c.nightDiffMultiplier)).toBe(1.1);
    expect(Number(c.overtimeMultiplier)).toBe(1.25);
    // ⭐ All three grace values are 0 on purpose: shipping a fix must never retroactively move pay.
    expect(c.lateGraceMinutes).toBe(0);
    expect(c.earlyOutGraceMinutes).toBe(0);
    expect(c.undertimeGraceMinutes).toBe(0);
    expect(c.latePolicy).toBe('record_only');
    expect(c.breakEnabled).toBe(true);
    // ⭐ D1, 2026-08-29: fingerprint, face and card are the modes of attendance. There is no
    // `credentialPasscode` — the PIN is not one of them, and has no switch to leave on.
    expect(c.credentialNfc && c.credentialFingerprint && c.credentialFace).toBe(true);
    expect('credentialPasscode' in c).toBe(false);
  });

  it('no column in the table is nullable except the two lifecycle ones', async () => {
    const cols = await sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'store_attendance_config'`;
    const nullable = cols.filter((c) => c.is_nullable === 'YES').map((c) => c.column_name).sort();
    expect(nullable).toEqual(['created_by', 'superseded_at']);
    // And the PIN switch is gone entirely, not merely defaulted to false (migration 0085).
    expect(cols.map((c) => c.column_name)).not.toContain('credential_passcode');
  });

  it('re-seeding a store that already has a config changes nothing', async () => {
    const f = await fixture('reseed');
    const again = await asOrg(f.orgId, (tx) =>
      seedAttendanceConfig(tx, { orgId: f.orgId, storeId: f.storeId, effectiveFrom: '2026-05-01' }),
    );
    expect(again.id).toBe(f.seeded.id);
    expect(again.effectiveFrom).toBe('2026-01-01');
  });
});

describe('T-155 invariant 5 — exactly one live config per store', () => {
  it('a second live row is refused by the database', async () => {
    const f = await fixture('one-live');
    await expect(sql`
      insert into store_attendance_config (org_id, store_id, effective_from)
      values (${f.orgId}, ${f.storeId}, '2026-07-01')`).rejects.toThrow(/unique|duplicate/i);
  });

  it('superseding leaves exactly one live row', async () => {
    const f = await fixture('supersede-live');
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-04-01'),
        changes: { requiredHoursPerShift: '10' },
      }),
    );
    const live = await sql`
      select id from store_attendance_config where store_id = ${f.storeId} and superseded_at is null`;
    expect(live).toHaveLength(1);
    const all = await sql`select id from store_attendance_config where store_id = ${f.storeId}`;
    expect(all).toHaveLength(2);
  });
});

describe('T-155 invariant 6 — a day is judged by the policy that governed IT', () => {
  it('⭐ reading the same store before and after a change gives the OLD answer for the OLD day', async () => {
    const f = await fixture('historical');
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-04-01'),
        changes: { requiredHoursPerShift: '10', lateGraceMinutes: 15 },
      }),
    );

    const march = await asOrg(f.orgId, (tx) =>
      getConfigForShiftDay(tx, { storeId: f.storeId, day: parseShiftDay('2026-03-15') }),
    );
    const april = await asOrg(f.orgId, (tx) =>
      getConfigForShiftDay(tx, { storeId: f.storeId, day: parseShiftDay('2026-04-15') }),
    );

    expect(Number(march.requiredHoursPerShift)).toBe(9);
    expect(march.lateGraceMinutes).toBe(0);
    expect(Number(april.requiredHoursPerShift)).toBe(10);
    expect(april.lateGraceMinutes).toBe(15);
  });

  it('the day the new policy takes effect uses the NEW policy', async () => {
    const f = await fixture('boundary');
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-04-01'),
        changes: { requiredHoursPerShift: '10' },
      }),
    );
    const onTheDay = await asOrg(f.orgId, (tx) =>
      getConfigForShiftDay(tx, { storeId: f.storeId, day: parseShiftDay('2026-04-01') }),
    );
    expect(Number(onTheDay.requiredHoursPerShift)).toBe(10);
  });

  it('a day BEFORE any config refuses rather than falling back to today’s rules', async () => {
    const f = await fixture('before-any');
    await expect(
      asOrg(f.orgId, (tx) =>
        getConfigForShiftDay(tx, { storeId: f.storeId, day: parseShiftDay('2025-12-31') }),
      ),
    ).rejects.toThrow(/cannot be adjudicated/i);
  });

  it('unchanged fields are inherited by the successor rather than reset to defaults', async () => {
    const f = await fixture('inherit');
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-03-01'),
        changes: { earlyOutGraceMinutes: 15, credentialFace: false },
      }),
    );
    const next = await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-06-01'),
        changes: { requiredHoursPerShift: '10' },
      }),
    );
    // ⚠️ The grace and the kill switch must survive a change that did not mention them. A supersede
    // that reset unmentioned fields to defaults would silently re-enable a disabled credential.
    expect(next.earlyOutGraceMinutes).toBe(15);
    expect(next.credentialFace).toBe(false);
    expect(Number(next.requiredHoursPerShift)).toBe(10);
  });
});

describe('T-155 invariant 4 — a superseded row cannot be edited or deleted, by ANY path', () => {
  it('raw SQL cannot change a policy column on a live row', async () => {
    const f = await fixture('immutable-live');
    await expect(sql`
      update store_attendance_config set required_hours_per_shift = 12 where id = ${f.seeded.id}`)
      .rejects.toThrow(/immutable/i);
  });

  it('raw SQL cannot change a policy column on a superseded row', async () => {
    const f = await fixture('immutable-old');
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-04-01'),
        changes: { requiredHoursPerShift: '10' },
      }),
    );
    await expect(sql`
      update store_attendance_config set late_charge_per_minute = 5 where id = ${f.seeded.id}`)
      .rejects.toThrow(/immutable/i);
  });

  it('raw SQL cannot DELETE a config row', async () => {
    const f = await fixture('no-delete');
    await expect(sql`delete from store_attendance_config where id = ${f.seeded.id}`)
      .rejects.toThrow(/never deleted/i);
  });

  it('a superseded row cannot be un-superseded', async () => {
    const f = await fixture('no-rewind');
    await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-04-01'),
        changes: { requiredHoursPerShift: '10' },
      }),
    );
    await expect(sql`
      update store_attendance_config set superseded_at = null where id = ${f.seeded.id}`)
      .rejects.toThrow(/immutable/i);
  });
});

describe('T-155 invariant 8 — a charge policy with a zero rate is refused', () => {
  it('charge_per_minute at rate 0 is a control that looks real and costs nothing', async () => {
    const f = await fixture('zero-rate');
    await expect(
      asOrg(f.orgId, (tx) =>
        supersedeConfig(tx, f.admin, {
          storeId: f.storeId,
          effectiveFrom: parseShiftDay('2026-04-01'),
          changes: { latePolicy: 'charge_per_minute' },
        }),
      ),
    ).rejects.toThrow(/charge_rate|check/i);
  });

  it('charge_per_minute with a real rate is accepted', async () => {
    const f = await fixture('real-rate');
    const next = await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-04-01'),
        changes: { latePolicy: 'charge_per_minute', lateChargePerMinute: '1.00' },
      }),
    );
    expect(next.latePolicy).toBe('charge_per_minute');
  });
});

describe('T-155 invariant 9 — allowed start hours are always sorted and distinct as stored', () => {
  it('an unsorted or duplicated array is REFUSED, not silently normalised', async () => {
    const f = await fixture('hours-unsorted');
    await expect(
      asOrg(f.orgId, (tx) =>
        supersedeConfig(tx, f.admin, {
          storeId: f.storeId,
          effectiveFrom: parseShiftDay('2026-04-01'),
          changes: { allowedShiftStartHours: [14, 9, 9] },
        }),
      ),
    ).rejects.toThrow(/allowed_hours|check/i);
  });

  it('an hour outside 0-23 is refused', async () => {
    const f = await fixture('hours-range');
    await expect(
      asOrg(f.orgId, (tx) =>
        supersedeConfig(tx, f.admin, {
          storeId: f.storeId,
          effectiveFrom: parseShiftDay('2026-04-01'),
          changes: { allowedShiftStartHours: [9, 24] },
        }),
      ),
    ).rejects.toThrow(/allowed_hours|check/i);
  });

  it('an empty set is refused — a store with no allowed start is not "unrestricted"', async () => {
    const f = await fixture('hours-empty');
    await expect(
      asOrg(f.orgId, (tx) =>
        supersedeConfig(tx, f.admin, {
          storeId: f.storeId,
          effectiveFrom: parseShiftDay('2026-04-01'),
          changes: { allowedShiftStartHours: [] },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a sorted, distinct set is accepted and read back identically', async () => {
    const f = await fixture('hours-ok');
    const next = await asOrg(f.orgId, (tx) =>
      supersedeConfig(tx, f.admin, {
        storeId: f.storeId,
        effectiveFrom: parseShiftDay('2026-04-01'),
        changes: { allowedShiftStartHours: [6, 14, 22] },
      }),
    );
    expect(next.allowedShiftStartHours).toEqual([6, 14, 22]);
  });
});

describe('T-155 — supersede ordering and authorization', () => {
  it('a new policy effective on or before the current one is refused', async () => {
    const f = await fixture('ordering');
    await expect(
      asOrg(f.orgId, (tx) =>
        supersedeConfig(tx, f.admin, {
          storeId: f.storeId,
          effectiveFrom: parseShiftDay('2026-01-01'),
          changes: { requiredHoursPerShift: '10' },
        }),
      ),
    ).rejects.toThrow(/take effect after/i);
  });

  it('a staff-role person cannot change the policy', async () => {
    const f = await fixture('authz');
    const [s] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Floor') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${s!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${s!.id}, ${f.storeId})`;
    await expect(
      asOrg(f.orgId, (tx) =>
        supersedeConfig(tx, actor(f.orgId, s!.id), {
          storeId: f.storeId,
          effectiveFrom: parseShiftDay('2026-04-01'),
          changes: { requiredHoursPerShift: '10' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('getLiveConfig on a store with no config says so rather than inventing defaults', async () => {
    const code = uid('bare');
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${org!.id}, ${code}, 'Bare') returning id`;
    await expect(
      asOrg(org!.id, (tx) => getLiveConfig(tx, { storeId: store!.id })),
    ).rejects.toThrow(/unconfigured/i);
  });
});
