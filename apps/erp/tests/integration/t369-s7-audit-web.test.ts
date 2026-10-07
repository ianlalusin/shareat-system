import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S7 AUDIT legs B and C (orchestrator, 2026-10-01). A and D are in
 * `packages/domain/tests/integration/t369-s7-audit-reentry.test.ts`.
 *
 *   B. The wastage action on a date with no live day, after the day was withdrawn: staff cannot re-enter that date
 *      (S7), so "record one first" is a dead end. The banner must tell them to ask a manager (/manager/i), no ids.
 *      Controls: a date that never had a day still reaches the same guard (a "no sales day" banner), and with a LIVE
 *      day the action does not say "No sales day" at all.
 *   C. Two concurrent re-entries of one voided date: the loser must meet a sentence, not a raw 23505. `errorMessage`
 *      is what every action's catch block calls, so the loser's error goes through it. The unique index's name is
 *      already pinned in the CONSTRAINT_MESSAGES lookup test.
 *
 * Harness from `t369-s6-account-lists-web.test.ts` (session mock, redirect signal, real domain).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

// The wastage actions re-throw only errors whose digest starts NEXT_REDIRECT (Next's own shape); anything else is shown as an error banner.
class RedirectSignal extends Error {
  digest = 'NEXT_REDIRECT';
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound() called — fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as D from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { errorMessage } from '../../src/lib/constraint-messages';
import { paramsOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DATE = '2026-01-10';

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

async function fixture(hint: string) {
  const code = uid(`t369s7w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const staffId = await mk('Staff', 'staff');
  const managerId = await mk('Manager', 'manager');
  const [channel] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });
  return { orgId, storeId, channelId: channel!.id, staff: actor(orgId, staffId), manager: actor(orgId, managerId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const figures = (f: Fixture) => ({
  totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: '1000.00', channels: [{ channelId: f.channelId, amount: '1000.00' }],
});
const create = (f: Fixture, who: Actor, date = DATE) => asOrg(f.orgId, (tx) => D.createSalesDay(tx, who, { storeId: f.storeId, businessDate: date, ...figures(f) }));
const withdraw = (f: Fixture, id: string) => asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, id, 'Typed wrong'));
const param = (to: string, k: string) => paramsOf(to).get(k);

async function banner(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectSignal) return param(err.to, 'error') ?? `(no error param) ${err.to}`;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

describe('S7 audit B — the wastage action on a date whose day was withdrawn', () => {
  const recordForm = (f: Fixture, date: string) => {
    const fd = new FormData();
    fd.set('storeId', f.storeId);
    fd.set('channel', 'Walk-in');
    fd.set('businessDate', date);
    fd.set('amount', '100.00');
    fd.set('reason', 'Dropped tray');
    return fd;
  };

  it('staff are told to ask a manager (no ids); controls: a never-entered date still says there is no sales day, and a LIVE day never does', async () => {
    const f = await fixture('auditB');
    const { recordOrderWastageAction } = await import('../../src/app/wastage/actions');
    ACTOR_HOLDER.actor = f.staff;

    // (Recording against a live day would itself block the withdrawal below - T11's wastage rule - so the live-day control is its own fixture.)
    const { id } = await create(f, f.staff);
    await withdraw(f, id);
    const afterWithdraw = await banner(() => recordOrderWastageAction(recordForm(f, DATE)));
    expect(afterWithdraw, 'a staff member was told to "record one first" for a date only a manager can re-enter').toMatch(/manager/i);
    expect(afterWithdraw).not.toMatch(UUID);

    const g = await fixture('auditB-live');
    ACTOR_HOLDER.actor = g.staff;
    await create(g, g.staff);
    const live = await banner(() => recordOrderWastageAction(recordForm(g, DATE)));
    expect(live, 'positive control: with a live day the guard is not the one speaking').toMatch(/Recorded|awaiting|resolved|posted/i);
    expect(live).not.toMatch(/No sales day/i);

    ACTOR_HOLDER.actor = f.staff;
    const never = await banner(() => recordOrderWastageAction(recordForm(f, '2026-01-20')));
    expect(never, 'control: a date that never had a day reaches the same guard').toMatch(/sales day/i);
  });
});

describe('S7 audit C — two concurrent re-entries of one voided date', () => {
  it('the loser meets a plain sentence ("Someone else just entered a sales day for this date. Reload the page."), not a raw unique-violation', async () => {
    const f = await fixture('auditC');
    const { id: first } = await create(f, f.staff);
    await withdraw(f, first);

    // The winner's transaction stays open after its insert; the loser starts meanwhile (it cannot see the winner's
    // uncommitted row, so it passes the existence check), blocks on the unique index, and fails once the winner commits.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let winnerInserted!: () => void;
    const inserted = new Promise<void>((r) => (winnerInserted = r));
    const winner = asOrg(f.orgId, async (tx) => {
      const made = await D.createSalesDay(tx, f.manager, { storeId: f.storeId, businessDate: DATE, ...figures(f) });
      winnerInserted();
      await gate;
      return made;
    });
    await inserted;
    const loser = create(f, f.manager).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await new Promise((r) => setTimeout(r, 800));
    release();
    await winner;
    const outcome = await loser;

    expect(outcome.ok, 'both concurrent re-entries succeeded: two live days for one date').toBe(false);
    if (outcome.ok) return;
    const shown = errorMessage(outcome.err);
    expect(shown, `a raw driver error reached the person: ${shown}`).toBe('Someone else just entered a sales day for this date. Reload the page.');
    expect(shown).not.toMatch(UUID);
    const rows = await sql<{ status: string }[]>`select status from sales_days where org_id = ${f.orgId} and store_id = ${f.storeId} and business_date = ${DATE}`;
    expect(rows.map((r) => r.status).sort(), 'exactly one live day plus the voided one').toEqual(['open', 'voided']);
  });
});
