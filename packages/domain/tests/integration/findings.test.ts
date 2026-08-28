import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-135 — integrity findings. `docs/tasks/135-integrity-findings.md`.
 *
 * ⭐ Invariants 1 and 2 of the spec are the shape of this file: **every kind has a test that makes
 * its condition true and proves it fires, AND a test proving it stays quiet otherwise.** A detector
 * with no firing test is a detector nobody knows works.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { acknowledgeFinding, closeReadiness, listFindings } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const PERIOD = '2026-01';

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
  const code = uid(`fi-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  return { orgId, storeId: store!.id, admin: actor(orgId, p!.id), personId: p!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Post a raw pair of legs. Used to MAKE a condition true. */
async function post(f: Fixture, legs: { code: string; debit?: string; credit?: string; party?: { t: string; id: string } }[], key: string) {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: '2026-01-10',
      sourceType: 'manual_journal',
      sourceId: key,
      idempotencyKey: key,
      memo: 'fixture',
      postedBy: f.personId,
      lines: legs.map((l) => ({
        accountCode: l.code,
        storeId: f.storeId,
        ...(l.debit ? { debit: l.debit } : {}),
        ...(l.credit ? { credit: l.credit } : {}),
        ...(l.party ? { partyType: l.party.t, partyId: l.party.id } : {}),
      })),
    }),
  );
}

const feed = (f: Fixture) => asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
const kinds = async (f: Fixture) => (await feed(f)).findings.map((x) => x.kind);

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('a clean ledger reports nothing', () => {
  it('⭐ no findings at all — every detector stays quiet when its condition is absent', async () => {
    const f = await fixture('clean');
    await post(f, [{ code: '6300', debit: '100.00' }, { code: '1110', credit: '100.00' }], uid('k'));
    const result = await feed(f);
    expect(result.findings).toEqual([]);
    expect(result.openCount).toBe(0);
    expect(result.hardCount).toBe(0);
  });
});

describe('each detector fires when its condition holds', () => {
  it('the reciprocal pair: 1250 without its 2150', async () => {
    const f = await fixture('recip');
    await post(
      f,
      [
        { code: '1250', debit: '500.00', party: { t: 'store', id: 'STORE-X' } },
        { code: '1110', credit: '500.00' },
      ],
      uid('k'),
    );
    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'dueFromDueToNotReciprocal');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('hard');
    expect(finding!.detail).toMatch(/went missing/);
  });

  it('⭐ a control account line with no party — money owed by nobody', async () => {
    const f = await fixture('noparty');
    // 1210 requires a party. Posting without one is exactly the shape that makes ageing lie.
    await sql`update accounts set requires_party = false where org_id = ${f.orgId} and code = '1210'`;
    await post(f, [{ code: '1210', debit: '250.00' }, { code: '4150', credit: '250.00' }], uid('k'));
    await sql`update accounts set requires_party = true where org_id = ${f.orgId} and code = '1210'`;

    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'subledgerDoesNotMatchControl');
    expect(finding).toBeDefined();
    expect(finding!.key).toBe('subledgerDoesNotMatchControl:1210');
    expect(finding!.detail).toMatch(/belongs to nobody/);
  });

  it('opening balance equity that does not net to zero', async () => {
    const f = await fixture('obe');
    await post(f, [{ code: '1110', debit: '900.00' }, { code: '3900', credit: '900.00' }], uid('k'));
    expect(await kinds(f)).toContain('openingBalanceEquityNonZero');
  });

  it('a channel clearing account that is not zero at rest', async () => {
    const f = await fixture('clearing');
    await post(f, [{ code: '1222', debit: '75.00' }, { code: '1110', credit: '75.00' }], uid('k'));
    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'clearingAccountNotAtRest');
    expect(finding).toBeDefined();
    // ⚠️ Soft: mid-flight is normal for a moment. It is the STANDING balance that is wrong.
    expect(finding!.severity).toBe('soft');
    expect(finding!.detail).toMatch(/did not finish/);
  });

  it('⭐ depreciation not booked — DEF-044, which cost two silent months in v1', async () => {
    const f = await fixture('depr');
    await sql`
      insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost,
                                useful_life_months, salvage_value, status, created_by)
      values (${f.orgId}, ${f.storeId}, 'Chiller', 'equipment', '2026-01-01', 50000, 60, 0, 'active', ${f.personId})`;
    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'depreciationNotBooked');
    expect(finding).toBeDefined();
    expect(finding!.detail).toMatch(/DEF-044/);
  });

  it('⚠️ and it stays quiet once the run is recorded — a no-op run still counts as having run', async () => {
    const f = await fixture('deprok');
    await sql`
      insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost,
                                useful_life_months, salvage_value, status, created_by)
      values (${f.orgId}, ${f.storeId}, 'Chiller', 'equipment', '2026-01-01', 50000, 60, 0, 'active', ${f.personId})`;
    await sql`
      insert into scheduler_runs (org_id, job, period, trigger, outcome)
      values (${f.orgId}, 'depreciation', ${PERIOD}, 'cron', 'ok')`;
    expect(await kinds(f)).not.toContain('depreciationNotBooked');
  });

  it('⛔ and it does NOT fire when there is nothing to depreciate', async () => {
    const f = await fixture('noassets');
    expect(await kinds(f)).not.toContain('depreciationNotBooked');
  });
});

describe('acknowledgement accepts a risk without pretending it is fixed', () => {
  async function withFinding(hint: string) {
    const f = await fixture(hint);
    await post(
      f,
      [
        { code: '1250', debit: '500.00', party: { t: 'store', id: 'STORE-X' } },
        { code: '1110', credit: '500.00' },
      ],
      uid('k'),
    );
    return f;
  }

  it('⭐ an acknowledged finding is off the attention list but STILL COUNTED', async () => {
    const f = await withFinding('ack');
    await asOrg(f.orgId, (tx) =>
      acknowledgeFinding(tx, f.admin, {
        findingKey: 'dueFromDueToNotReciprocal',
        note: 'Chasing the missing transfer with Malvar.',
        period: PERIOD,
      }),
    );
    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'dueFromDueToNotReciprocal')!;
    expect(finding.status).toBe('acknowledged');
    expect(finding.acknowledgedBy).toBe(f.personId);
    expect(finding.acknowledgementAgeDays).toBe(0);
    // ⭐ The difference from "resolved": it is still there, still counted.
    expect(result.openCount).toBe(0);
    expect(result.acknowledgedCount).toBe(1);
  });

  it('⭐ the finding VANISHES when the condition is fixed, with nobody touching it', async () => {
    const f = await withFinding('fixed');
    expect(await kinds(f)).toContain('dueFromDueToNotReciprocal');

    // Post the missing other half.
    await post(
      f,
      [
        { code: '1110', debit: '500.00' },
        { code: '2150', credit: '500.00', party: { t: 'store', id: 'STORE-Y' } },
      ],
      uid('k'),
    );
    expect(await kinds(f)).not.toContain('dueFromDueToNotReciprocal');
  });

  it('⛔ a finding that is not currently true cannot be acknowledged in advance', async () => {
    const f = await fixture('advance');
    await expect(
      asOrg(f.orgId, (tx) =>
        acknowledgeFinding(tx, f.admin, { findingKey: 'trialBalanceDoesNotTie', period: PERIOD }),
      ),
    ).rejects.toThrow(/not currently a finding/);
  });

  it('⚠️ an expired acknowledgement stops suppressing, on its own', async () => {
    const f = await withFinding('expired');
    await asOrg(f.orgId, (tx) =>
      acknowledgeFinding(tx, f.admin, { findingKey: 'dueFromDueToNotReciprocal', period: PERIOD }),
    );
    // Age it past the window. An accepted risk should be RE-accepted, not forgotten.
    await sql`
      update finding_acknowledgements
      set acknowledged_at = now() - interval '40 days', expires_at = now() - interval '10 days'
      where org_id = ${f.orgId}`;
    const result = await feed(f);
    expect(result.findings.find((x) => x.kind === 'dueFromDueToNotReciprocal')!.status).toBe('open');
    expect(result.openCount).toBe(1);
  });
});

describe('close readiness is a FILTER over the same feed, not a second engine', () => {
  it('a hard finding blocks the close even when acknowledged', async () => {
    const f = await fixture('close');
    await post(
      f,
      [
        { code: '1250', debit: '500.00', party: { t: 'store', id: 'STORE-X' } },
        { code: '1110', credit: '500.00' },
      ],
      uid('k'),
    );
    await asOrg(f.orgId, (tx) =>
      acknowledgeFinding(tx, f.admin, { findingKey: 'dueFromDueToNotReciprocal', period: PERIOD }),
    );
    const readiness = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, PERIOD));
    // ⚠️ Accepting a risk is not the same as the books adding up.
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking.map((b) => b.kind)).toContain('dueFromDueToNotReciprocal');
  });

  it('a clean ledger is ready to close', async () => {
    const f = await fixture('ready');
    await post(f, [{ code: '6300', debit: '10.00' }, { code: '1110', credit: '10.00' }], uid('k'));
    const readiness = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, PERIOD));
    expect(readiness.ready).toBe(true);
  });
});
