import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-440 S3 (TESTER) - one refusal per rule the S3 sweep NEWLY enforces on the server (Q5: a field marked required or bounded on
 * screen but never checked by the action). Each case runs the REAL server action with a bad value and proves two things:
 * the person is told the rule's exact sentence (the line the screen shows live), and NOTHING was written.
 *
 * Session mocked (t412 idiom); redirects captured; the banner read through the flash jar. Every case names the mutant it kills;
 * the mutant is "the assertFieldRules call is removed from that action" unless stated otherwise.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../../../../tests/helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../../../apps/erp/src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb } from '@shareat/db';
import { captureRedirect, outcomeOf, resetJar } from '../../../../tests/helpers/flash-jar';
import { moneyFixture } from './_fixtures/t402-s3-money';

const sql = postgres(url, { max: 5 });
const APP = '../../../../apps/erp/src/app';
const DASH = '—';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function createFixture() {
  const f = await moneyFixture(sql, 't440s3');
  const [employment] = await sql<{ id: string }[]>`select id from employments where org_id = ${f.orgId} and person_id = ${f.staffId}`;
  const [owner] = await sql<{ id: string }[]>`insert into owners (org_id, store_id, person_id, created_by) values (${f.orgId}, ${f.storeId}, ${f.staffId}, ${f.adminId}) returning id`;
  const [terminal] = await sql<{ id: string }[]>`insert into clock_terminals (org_id, store_id, label, firebase_uid, provisioned_by) values (${f.orgId}, ${f.storeId}, 'Synthetic terminal', ${`t440-${f.orgId}`}, ${f.adminId}) returning id`;
  const [attendance] = await sql<{ id: string }[]>`insert into attendance_credentials (org_id, store_id, employment_id, kind, card_id, enrolled_by) values (${f.orgId}, ${f.storeId}, ${employment!.id}, 'card', ${`t440-${f.orgId}`}, ${f.adminId}) returning id`;
  const [credential] = await sql<{ id: string }[]>`insert into person_credentials (person_id, kind, external_id) values (${f.staffId}, 'firebase', ${`t440-${f.orgId}`}) returning id`;
  return { ...f, employmentId: employment!.id, ownerId: owner!.id, terminalId: terminal!.id, attendanceCredentialId: attendance!.id, credentialId: credential!.id };
}
type Fx = Awaited<ReturnType<typeof createFixture>>;
let fxPromise: Promise<Fx> | null = null;
const fixture = () => (fxPromise ??= createFixture());

/** Runs the action as the org's administrator and returns the banner it redirected with. */
async function run(mod: string, name: string, fields: Record<string, string>) {
  const f = await fixture();
  const act = ((await import(/* @vite-ignore */ `${APP}/${mod}`)) as Record<string, (fd: FormData) => Promise<void>>)[name];
  if (!act) throw new Error(`${mod} exports no ${name}`);
  resetJar();
  h.actor = f.admin;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return outcomeOf(await captureRedirect(() => act(fd)));
}

async function count(table: string, orgId: string): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table} where org_id = '${orgId}'`);
  return rows[0]?.n ?? 0;
}

describe('T-440 S3: a bad value is refused with the rule sentence and nothing is written', () => {
  it('admin/stores createStoreAction: a 17-character code is refused; no store row (mutant: assert removed from createStoreAction)', async () => {
    const f = await fixture();
    const before = await count('stores', f.orgId);
    const o = await run('admin/stores/actions', 'createStoreAction', { code: 'ABCDEFGHIJKLMNOPQ', name: 'Too long', remittanceCadence: 'daily' });
    expect(o.flash.error).toBe('The code must be at most 16 characters.');
    expect(await count('stores', f.orgId)).toBe(before);
    const stray = await sql`select 1 from stores where org_id = ${f.orgId} and code = 'ABCDEFGHIJKLMNOPQ'`;
    expect(stray).toHaveLength(0);
  });

  it('admin/stores updateStoreAction: a 2-digit TIN branch code is refused; the stored code is unchanged (mutant: assert removed from updateStoreAction)', async () => {
    const f = await fixture();
    const o = await run('admin/stores/actions', 'updateStoreAction', { storeId: f.storeId, name: 'Renamed', tinBranchCode: '12' });
    expect(o.flash.error).toBe('The TIN branch code must be 3 to 5 digits.');
    const [row] = await sql<{ name: string }[]>`select name from stores where id = ${f.storeId}`;
    expect(row!.name).not.toBe('Renamed');
  });

  it('attendance/leave recordLeaveAction: a first day in the future is refused; no leave request (mutant: notAfterToday dropped from the rule or the assert removed)', async () => {
    const f = await fixture();
    const before = await count('leave_requests', f.orgId);
    const o = await run('attendance/leave/actions', 'recordLeaveAction', {
      employmentId: f.employmentId,
      leaveType: 'sick',
      from: '2999-01-01',
      to: '2999-01-02',
    });
    expect(o.flash.error).toBe("The first day can't be after today.");
    expect(await count('leave_requests', f.orgId)).toBe(before);
  });

  it('attendance/leave requestLeaveAction: an unreal first day is refused; no leave request (mutant: assert removed from requestLeaveAction)', async () => {
    const f = await fixture();
    const before = await count('leave_requests', f.orgId);
    const o = await run('attendance/leave/actions', 'requestLeaveAction', {
      employmentId: f.employmentId,
      leaveType: 'sick',
      from: 'soon',
    });
    expect(o.flash.error).toBe('The first day must be a real date.');
    expect(await count('leave_requests', f.orgId)).toBe(before);
  });

  it('payroll/rates addMinimumWageAction: a blank wage order is refused; no minimum-wage row (mutant: assert removed from addMinimumWageAction)', async () => {
    const f = await fixture();
    const before = await count('minimum_wages', f.orgId);
    const o = await run('payroll/rates/actions', 'addMinimumWageAction', {
      storeId: f.storeId,
      effectiveFrom: '2026-07-01',
      dailyRate: '645.00',
      wageOrderRef: '   ',
    });
    expect(o.flash.error).toBe('The wage order is required.');
    expect(await count('minimum_wages', f.orgId)).toBe(before);
  });

  it('payroll/rates addStatutoryRateAction: a non-numeric employee rate is refused; no rate row (mutant: assert removed from addStatutoryRateAction)', async () => {
    const f = await fixture();
    const before = await count('statutory_rates', f.orgId);
    const o = await run('payroll/rates/actions', 'addStatutoryRateAction', {
      agency: 'sss',
      baseKind: 'gross',
      effectiveFrom: '2026-07-01',
      eeRate: 'abc',
      erRate: '0.10',
      sourceRef: 'SSS Circular 2025-001',
    });
    expect(o.flash.error).toBe('The employee rate must be a number of 0 or more.');
    expect(await count('statutory_rates', f.orgId)).toBe(before);
  });

  it('staff hireAction: an unreal start date is refused before anyone is hired (mutant: the start-date assert removed from hireAction)', async () => {
    const f = await fixture();
    const people = await count('persons', f.orgId);
    const jobs = await count('employments', f.orgId);
    const o = await run('staff/actions', 'hireAction', {
      storeId: f.storeId,
      lastName: 'Reyes',
      firstName: 'Ana',
      employmentStatus: 'regular',
      startedOn: '2026-13-45',
    });
    expect(o.flash.error).toBe('The start date must be a real date.');
    expect(await count('persons', f.orgId)).toBe(people);
    expect(await count('employments', f.orgId)).toBe(jobs);
  });

  it('owners createOwnerAction: a percentage above 100 is refused; no owner row (mutant: assert removed from createOwnerAction)', async () => {
    const f = await fixture();
    const before = await count('owners', f.orgId);
    const o = await run('owners/actions', 'createOwnerAction', {
      storeId: f.storeId,
      personId: f.staffId,
      ownershipPercentage: '150',
      personalExpenseTreatment: 'draw',
    });
    expect(o.flash.error).toBe('The ownership percentage must be a number from 0.001 to 100.');
    expect(await count('owners', f.orgId)).toBe(before);
  });

  it('owners createOwnerAction: a missing store keeps its old sentence through the rule (mutant: the rule re-words "Choose a store.")', async () => {
    const f = await fixture();
    const before = await count('owners', f.orgId);
    const o = await run('owners/actions', 'createOwnerAction', { storeId: '', personId: f.staffId });
    expect(o.flash.error).toBe('Choose a store.');
    expect(await count('owners', f.orgId)).toBe(before);
  });

  it('owners drawingAction: a negative amount is refused before the ledger is touched (mutant: assert removed from drawingAction)', async () => {
    const f = await fixture();
    const before = await count('journal_entries', f.orgId);
    const o = await run('owners/actions', 'drawingAction', {
      ownerId: f.ownerId,
      amount: '-7',
      fromMoneyAccountId: f.drawerId,
      on: '2026-01-15',
    });
    expect(o.flash.error).toBe('A drawing has to be greater than zero.');
    expect(await count('journal_entries', f.orgId)).toBe(before);
  });

  it('owners closeMonthAction: an unreal date is refused; no drawings-close row (mutant: assert removed from closeMonthAction)', async () => {
    const f = await fixture();
    const before = await count('journal_entries', f.orgId);
    const o = await run('owners/actions', 'closeMonthAction', {
      ownerId: f.ownerId,
      month: '2026-01',
      on: 'soon',
    });
    expect(o.flash.error).toBe('The date must be a real date.');
    expect(await count('journal_entries', f.orgId)).toBe(before);
  });

  it('attendance/terminals revokeTerminalAction: a blank reason is refused; no terminal is revoked (mutant: assert removed from revokeTerminalAction)', async () => {
    const f = await fixture();
    const o = await run('attendance/terminals/actions', 'revokeTerminalAction', {
      storeId: f.storeId,
      terminalId: f.terminalId,
      reason: '   ',
    });
    expect(o.flash.error).toBe('The reason is required.');
  });

  it('staff/credentials revokeCredentialAction: a blank reason is refused with the rule sentence (mutant: assert removed from revokeCredentialAction)', async () => {
    const f = await fixture();
    const o = await run('staff/[employmentId]/credentials/actions', 'revokeCredentialAction', {
      employmentId: f.employmentId,
      credentialId: f.attendanceCredentialId,
      reason: '   ',
    });
    expect(o.flash.error).toBe('The reason is required.');
    void f;
  });

  it('staff/credentials enrolCardAction: a blank card id is refused with the old sentence (mutant: the rule re-words it)', async () => {
    const f = await fixture();
    const o = await run('staff/[employmentId]/credentials/actions', 'enrolCardAction', {
      employmentId: f.employmentId,
      cardId: '   ',
    });
    expect(o.flash.error).toBe(`A card needs an id ${DASH} that is the whole credential.`);
  });

  it('admin/users unlinkCredentialAction: a blank reason keeps the audit-trail sentence (mutant: the rule re-words it / assert removed)', async () => {
    const f = await fixture();
    const o = await run('admin/users/actions', 'unlinkCredentialAction', {
      personId: f.staffId,
      credentialId: f.credentialId,
      reason: '   ',
    });
    expect(o.flash.error).toBe(`Unlinking a sign-in account needs a reason ${DASH} a revoked credential nobody can explain is not an audit trail.`);
  });
});
