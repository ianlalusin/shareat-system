import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-374 S1 / DEF-577 (domain) - every "today" the domain fills in, and every stored instant it prints as a date, is the
 * MANILA business date, never the UTC date. TESTER. docs/tasks/374-money-push-follow-ups.md S1.
 *
 * The clock is 02:00 Manila on 1 April 2026 = 18:00 UTC on 31 March, where the two calendars disagree. Stored instants
 * are pinned with raw SQL to the same moment. A sentence may print the date ISO or humanDate'd; the test accepts either
 * spelling of 1 April and refuses either spelling of 31 March.
 *   T1 decideCashRequest with no `on` -> decided_on 2026-04-01.   T2 isOverdue default asOf.
 *   T3a revokeCredential twice.  T3b a revoked terminal (requireLive).  T3c retry of a resolved quarantine row.
 *   T3d an event from a revoked terminal: the quarantine reason_detail.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  CredentialError,
  LaneHealthError,
  TerminalError,
  activateTerminal,
  createCashRequest,
  createEmployment,
  decideCashRequest,
  discardQuarantined,
  enrolCard,
  ingestEvents,
  isOverdue,
  provisionTerminal,
  retryQuarantined,
  revokeCredential,
  revokeTerminal,
  seedAttendanceConfig,
  seedCanonicalPositions,
  shiftDayRange,
  toShiftDay,
  type TerminalIdentityDriver,
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

/** 02:00 Manila on 1 April 2026 = 18:00 UTC on 31 March. */
const MANILA_2AM_APRIL_1 = new Date('2026-03-31T18:00:00.000Z');
const MANILA_10AM_APRIL_1 = new Date('2026-04-01T02:00:00.000Z');
async function withClock<T>(at: Date, run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: at });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

const SAYS_APRIL_1 = /2026-04-01|1 Apr(il)? 2026|Apr(il)? 1, 2026/;
const SAYS_MARCH_31 = /2026-03-31|31 Mar(ch)? 2026|Mar(ch)? 31, 2026/;
function expectApril1(message: string, what: string) {
  expect(message, `${what}: ${message}`).toMatch(SAYS_APRIL_1);
  expect(message, `${what}: ${message}`).not.toMatch(SAYS_MARCH_31);
}

const driver: TerminalIdentityDriver = {
  async mintCustomToken() {
    return 'token';
  },
  async disable() {},
};

const DAY = toShiftDay(new Date(Date.now() - 24 * 3_600_000));
const DAY_START = shiftDayRange(DAY).start.getTime();
const at = (hour: number, minute = 0) => DAY_START + (((((hour - 5) % 24) + 24) % 24) * 60 + minute) * 60_000;

async function fixture(hint: string) {
  const code = uid(`t374s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [adminP] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminP!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminP!.id}, ${store!.id})`;
  const [worker] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Maria Santos') returning id`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const admin = actor(orgId, adminP!.id);
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }));
  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, admin, { storeId: store!.id, personId: worker!.id, employmentStatus: 'regular', startedOn: '2026-01-05' }),
  );
  const { terminal } = await asOrg(orgId, (tx) =>
    provisionTerminal(tx, admin, driver, { storeId: store!.id, label: 'Counter' }),
  );
  await asOrg(orgId, (tx) => activateTerminal(tx, { terminalId: terminal.id }));
  const cardId = uid('card');
  const credential = await asOrg(orgId, (tx) => enrolCard(tx, admin, { employmentId: employment.id, cardId }));
  await sql`update attendance_credentials set enrolled_at = now() - interval '30 days' where id = ${credential.id}`;
  return { orgId, storeId: store!.id, adminPersonId: adminP!.id, admin, terminal, credential, cardId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const event = (f: Fixture, over: Record<string, unknown> = {}) => ({
  clientPunchId: uid('cp'),
  occurredAt: at(14),
  deviceId: f.terminal.id,
  storeId: f.storeId,
  credentialKind: 'card',
  credentialRef: f.cardId,
  method: 'qr',
  assertedIntent: 'in',
  ...over,
});

// -----------------------------------------------------------------------------------------------

describe('T-374 S1 T1 - decideCashRequest with no `on` dates the decision on the Manila day', () => {
  async function pending(f: Fixture) {
    return asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.admin, { storeId: f.storeId, requestedFor: f.adminPersonId, purpose: 'Market run', amount: '2000.00', on: '2026-03-30' }),
    );
  }
  const decidedOn = async (id: string) =>
    (await sql<{ d: string | null }[]>`select decided_on::text as d from cash_requests where id = ${id}`)[0]!.d;

  it('approve at 02:00 Manila on 1 April -> decided_on 2026-04-01 (HEAD: 2026-03-31)', async () => {
    const f = await fixture('t1a');
    const req = await pending(f);
    await withClock(MANILA_2AM_APRIL_1, () =>
      asOrg(f.orgId, (tx) => decideCashRequest(tx, f.admin, { requestId: req.id, decision: 'approve', amount: '1500.00' })),
    );
    expect(await decidedOn(req.id)).toBe('2026-04-01');
  });

  it('reject with no `on` at the same instant -> decided_on 2026-04-01', async () => {
    const f = await fixture('t1b');
    const req = await pending(f);
    await withClock(MANILA_2AM_APRIL_1, () =>
      asOrg(f.orgId, (tx) => decideCashRequest(tx, f.admin, { requestId: req.id, decision: 'reject', reason: 'Not needed' })),
    );
    expect(await decidedOn(req.id)).toBe('2026-04-01');
  });

  it('control: an explicit `on` is kept, whatever the clock says', async () => {
    const f = await fixture('t1c');
    const req = await pending(f);
    await withClock(MANILA_2AM_APRIL_1, () =>
      asOrg(f.orgId, (tx) => decideCashRequest(tx, f.admin, { requestId: req.id, decision: 'approve', amount: '1500.00', on: '2026-03-30' })),
    );
    expect(await decidedOn(req.id)).toBe('2026-03-30');
  });

  it('control: at 10:00 Manila on 1 April the default is 2026-04-01 on HEAD and after', async () => {
    const f = await fixture('t1d');
    const req = await pending(f);
    await withClock(MANILA_10AM_APRIL_1, () =>
      asOrg(f.orgId, (tx) => decideCashRequest(tx, f.admin, { requestId: req.id, decision: 'approve', amount: '1500.00' })),
    );
    expect(await decidedOn(req.id)).toBe('2026-04-01');
  });
});

describe('T-374 S1 T2 - isOverdue judges "today" by the Manila day', () => {
  it('due 31 March is overdue at 02:00 Manila on 1 April (HEAD: not, "today" is the 31st)', async () => {
    expect(await withClock(MANILA_2AM_APRIL_1, async () => isOverdue('2026-03-31', '100.00'))).toBe(true);
  });
  it('control: at 10:00 Manila the same is overdue', async () => {
    expect(await withClock(MANILA_10AM_APRIL_1, async () => isOverdue('2026-03-31', '100.00'))).toBe(true);
  });
  it('control: due 1 April is not overdue on 1 April; nothing owed is never overdue; an explicit asOf wins', async () => {
    expect(await withClock(MANILA_2AM_APRIL_1, async () => isOverdue('2026-04-01', '100.00'))).toBe(false);
    expect(await withClock(MANILA_2AM_APRIL_1, async () => isOverdue('2026-03-31', '0.00'))).toBe(false);
    expect(await withClock(MANILA_2AM_APRIL_1, async () => isOverdue('2026-03-31', '100.00', '2026-03-31'))).toBe(false);
  });
});

describe('T-374 S1 T3 - a stored instant in a sentence reads as its Manila date', () => {
  const INSTANT = '2026-03-31T18:00:00.000Z'; // 02:00 Manila, 1 April

  it('3a revokeCredential on an already-revoked credential names 1 April', async () => {
    const f = await fixture('t3a');
    await asOrg(f.orgId, (tx) => revokeCredential(tx, f.admin, { credentialId: f.credential.id, reason: 'Badge lost.' }));
    await sql`update attendance_credentials set revoked_at = ${INSTANT} where id = ${f.credential.id}`;
    const err = await asOrg(f.orgId, (tx) =>
      revokeCredential(tx, f.admin, { credentialId: f.credential.id, reason: 'Again.' }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialError);
    expectApril1((err as Error).message, 'revoked credential');
  });

  it('3b a revoked terminal (requireLive, via activateTerminal) names 1 April', async () => {
    const f = await fixture('t3b');
    await asOrg(f.orgId, (tx) => revokeTerminal(tx, f.admin, driver, { terminalId: f.terminal.id, reason: 'Stolen' }));
    await sql`update clock_terminals set revoked_at = ${INSTANT} where id = ${f.terminal.id}`;
    const err = await asOrg(f.orgId, (tx) => activateTerminal(tx, { terminalId: f.terminal.id })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expectApril1((err as Error).message, 'revoked terminal');
  });

  it('3c retrying a resolved quarantine row names 1 April', async () => {
    const f = await fixture('t3c');
    const e = event(f, { credentialRef: uid('ghost') });
    await asOrg(f.orgId, (tx) => ingestEvents(tx, [e]));
    const [row] = await sql<{ id: string }[]>`select id from inbox_quarantine where client_punch_id = ${e.clientPunchId}`;
    await asOrg(f.orgId, (tx) =>
      discardQuarantined(tx, f.admin, { quarantineId: row!.id, storeId: f.storeId, reason: 'duplicate' }),
    );
    await sql`update inbox_quarantine set resolved_at = ${INSTANT} where id = ${row!.id}`;
    const err = await asOrg(f.orgId, (tx) =>
      retryQuarantined(tx, f.admin, { quarantineId: row!.id, storeId: f.storeId }),
    ).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(LaneHealthError);
    expectApril1((err as Error).message, 'resolved quarantine row');
  });

  it('3d an event from a terminal revoked at that instant is quarantined with 1 April in its reason', async () => {
    const f = await fixture('t3d');
    await asOrg(f.orgId, (tx) => revokeTerminal(tx, f.admin, driver, { terminalId: f.terminal.id, reason: 'Stolen' }));
    await sql`update clock_terminals set revoked_at = ${INSTANT} where id = ${f.terminal.id}`;
    const e = event(f);
    const report = await asOrg(f.orgId, (tx) => ingestEvents(tx, [e]));
    expect(report.byReason.revoked_device).toBe(1);
    const [row] = await sql<{ reason_detail: string }[]>`select reason_detail from inbox_quarantine where client_punch_id = ${e.clientPunchId}`;
    expectApril1(row!.reason_detail, 'revoked_device reason_detail');
  });

  it('control: an instant that is the same day in both calendars reads 1 April', async () => {
    const f = await fixture('t3e');
    await asOrg(f.orgId, (tx) => revokeCredential(tx, f.admin, { credentialId: f.credential.id, reason: 'Badge lost.' }));
    await sql`update attendance_credentials set revoked_at = '2026-04-01T04:00:00.000Z' where id = ${f.credential.id}`;
    const err = await asOrg(f.orgId, (tx) =>
      revokeCredential(tx, f.admin, { credentialId: f.credential.id, reason: 'Again.' }),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(SAYS_APRIL_1);
  });
});
