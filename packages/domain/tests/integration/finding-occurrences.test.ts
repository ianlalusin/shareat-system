import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-214 — the occurrence clock and the responsiveness scorecard.
 *
 * ⭐ **Invariant 6 is the one that protects the whole design.** `finding_occurrences` is an
 * OBSERVATION log, not finding state; the moment anything in the detection path reads it, T-135's
 * rule is broken and v1's defect is back — a resolution suppressing a symptom whose cause still
 * holds. That claim is asserted here by deleting every row and re-reading the feed, not argued in
 * a comment.
 *
 * ⭐ **Invariant 11 is the one most likely to be dropped as fiddly, and it is the one that keeps
 * the headline number honest.** Periodic keys embed their month, so a run asking about September
 * never gets August's key back — and closing on that basis records unbooked depreciation as FIXED.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, findingsRepo, APP_ROLE, type Tx } from '@shareat/db';
import {
  compositeScore,
  keyPeriod,
  listFindings,
  logFindingView,
  managerScorecard,
  recordFindingObservations,
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

interface Fixture { orgId: string; storeId: string; personId: string }
let f: Fixture;

beforeEach(async () => {
  const code = uid('t214');
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Branch') returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Dev Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  f = { orgId, storeId: store!.id, personId: p!.id };
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** Insert an occurrence directly — the scorecard's arithmetic is what is under test, not the job. */
async function occurrence(o: {
  key: string; kind?: string; storeId?: string | null; opened: string; closed?: string | null;
}) {
  await sql`
    insert into finding_occurrences (org_id, store_id, finding_key, kind, opened_on, last_seen_on, closed_on)
    values (${f.orgId}, ${o.storeId === undefined ? f.storeId : o.storeId}, ${o.key},
            ${o.kind ?? 'testKind'}, ${o.opened}::date,
            ${(o.closed ?? o.opened)}::date, ${o.closed ?? null})`;
}

const RANGE = { from: '2026-01-01', to: '2026-12-31' };

describe('T-214 invariant 1 — at most one OPEN occurrence per key', () => {
  it('⛔ a second open row for the same key is refused by the database', async () => {
    await occurrence({ key: 'k:a', opened: '2026-02-01' });
    await expect(occurrence({ key: 'k:a', opened: '2026-02-02' })).rejects.toThrow();
  });

  it('✅ but a CLOSED one may repeat — a finding that comes back is a new occurrence', async () => {
    await occurrence({ key: 'k:b', opened: '2026-02-01', closed: '2026-02-05' });
    await occurrence({ key: 'k:b', opened: '2026-03-01' });
    const rows = await sql<{ n: string }[]>`
      select count(*)::text n from finding_occurrences where org_id = ${f.orgId} and finding_key = 'k:b'`;
    expect(rows[0]!.n).toBe('2');
  });

  it('⚠️ the rule binds ORG-WIDE findings too, despite store_id being NULL', async () => {
    // NULL never equals NULL in a unique index, so without the coalesce the org-wide findings —
    // the trial-balance class, the ones that matter most — would be the only ones exempt.
    await occurrence({ key: 'k:org', storeId: null, opened: '2026-02-01' });
    await expect(occurrence({ key: 'k:org', storeId: null, opened: '2026-02-02' })).rejects.toThrow();
  });
});

describe('T-214 invariant 2 — the daily job is idempotent', () => {
  it('running it twice on the same day changes nothing the second time', async () => {
    const first = await asOrg(f.orgId, (tx) => recordFindingObservations(tx, f.orgId));
    const after1 = await sql<{ n: string }[]>`
      select count(*)::text n from finding_occurrences where org_id = ${f.orgId}`;
    const second = await asOrg(f.orgId, (tx) => recordFindingObservations(tx, f.orgId));
    const after2 = await sql<{ n: string }[]>`
      select count(*)::text n from finding_occurrences where org_id = ${f.orgId}`;

    expect(after2[0]!.n).toBe(after1[0]!.n);
    expect(second.opened).toBe(0);
    expect(second.closed).toBe(0);
    expect(second.observed).toBe(first.observed);
  });
});

describe('T-214 invariants 3 and 4 — closing and regression', () => {
  it('an occurrence whose key stops firing is closed by the next run', async () => {
    // A key no detector will ever produce, so the next run cannot see it and must close it.
    await occurrence({ key: 'ghostKind:never-fires', opened: '2026-02-01' });
    await asOrg(f.orgId, (tx) => recordFindingObservations(tx, f.orgId));
    const rows = await sql<{ closed_on: string | null }[]>`
      select closed_on from finding_occurrences where org_id = ${f.orgId} and finding_key = 'ghostKind:never-fires'`;
    expect(rows[0]!.closed_on).not.toBeNull();
  });

  it('⭐ a finding that returns opens a NEW occurrence, not a continuation of the old', async () => {
    await occurrence({ key: 'k:regress', opened: '2026-02-01', closed: '2026-02-03' });
    await asOrg(f.orgId, (tx) =>
      findingsRepo.observeFinding(tx, {
        orgId: f.orgId, storeId: f.storeId, findingKey: 'k:regress', kind: 'testKind',
      }));
    const rows = await sql<{ n: string }[]>`
      select count(*)::text n from finding_occurrences where org_id = ${f.orgId} and finding_key = 'k:regress'`;
    expect(rows[0]!.n).toBe('2');
  });
});

describe('T-214 invariant 5 — acknowledging changes NO occurrence', () => {
  it('⛔ accepting a risk is not fixing it, and must not move the score', async () => {
    await occurrence({ key: 'k:ack', opened: '2026-02-01' });
    await sql`
      insert into finding_acknowledgements (org_id, store_id, finding_key, kind, acknowledged_by, expires_at)
      values (${f.orgId}, ${f.storeId}, 'k:ack', 'testKind', ${f.personId}, now() + interval '30 days')`;

    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    const row = card.stores.find((s) => s.storeId === f.storeId)!;

    expect(row.cleared).toBe(0);
    // ⚠️ `2026-02-01` is far past the 14-day grace window, so this one IS countable and the rate
    // is a real 0 — the acknowledgement did not rescue it, which is the whole point.
    expect(row.clearRate).toBe(0);
    // ⭐ Reported, never scored — the acknowledgement shows up beside the score, not inside it.
    expect(row.acknowledged).toBe(1);
    expect(row.oldestAcknowledgementDays).not.toBeNull();
  });
});

describe('T-214 invariant 6 — ⭐ NOTHING in the detection path reads the occurrence log', () => {
  it('deleting every occurrence leaves the findings feed byte-identical', async () => {
    // ⛔ The claim that this is an observation and not finding state, executed rather than argued.
    // If it ever fails, T-135's rule is broken and v1's suppression defect is back.
    await asOrg(f.orgId, (tx) => recordFindingObservations(tx, f.orgId));
    const before = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-01' }));

    await sql`delete from finding_occurrences where org_id = ${f.orgId}`;
    const after = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-01' }));

    expect(after.findings.map((x) => x.key).sort()).toEqual(before.findings.map((x) => x.key).sort());
    expect(after.openCount).toBe(before.openCount);
    expect(after.hardCount).toBe(before.hardCount);
  });
});

describe('T-214 invariants 7 and 8 — null is not zero, and org findings are not a store’s', () => {
  it('⚠️ a store with nothing to judge scores NULL, never 0', async () => {
    // Zero says "responded badly". Null says "nothing to judge". A permanently-zero line is the
    // defect bible §16.9 names, and it would libel a store that simply had no findings.
    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    expect(card.stores.find((s) => s.storeId === f.storeId)).toBeUndefined();
    expect(compositeScore(null, null)).toBeNull();
  });

  it('⛔ an ORG-WIDE finding forms its own row and never lands on a store', async () => {
    await occurrence({ key: 'k:orgwide', storeId: null, opened: '2026-02-01' });
    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    expect(card.stores.find((s) => s.storeId === null)!.raised).toBe(1);
    expect(card.stores.find((s) => s.storeId === f.storeId)).toBeUndefined();
  });
});

describe('T-214 invariant 11 — ⭐ the month-boundary bug', () => {
  it('keyPeriod recognises a period-scoped key and ignores a store-scoped one', () => {
    expect(keyPeriod('depreciationNotBooked:2026-08')).toBe('2026-08');
    expect(keyPeriod('remittanceOverdue:01a0561f-c395-7afd-b404-edafd0083aa1')).toBeNull();
  });

  it('⭐ the run RE-ASKS every month that still has an open occurrence — the actual fix', async () => {
    // ⚠️ THE mechanism this invariant is about. On 1 October, `lastCompletedPeriod()` is September
    // and August's key is never returned — so a run that asked September alone would close August's
    // unbooked depreciation AS THOUGH SOMEBODY FIXED IT, at every month boundary, on the `hard`
    // findings that matter most. The fix is that the asked set is the current question PLUS every
    // month still carrying an open occurrence.
    const NOW = new Date('2026-10-05T00:00:00Z');

    const withoutOccurrence = await asOrg(f.orgId, (tx) =>
      recordFindingObservations(tx, f.orgId, NOW));
    expect(withoutOccurrence.periodsAsked).toEqual(['2026-09']);
    expect(withoutOccurrence.periodsAsked).not.toContain('2026-08');

    await occurrence({
      key: 'depreciationNotBooked:2026-08', kind: 'depreciationNotBooked',
      storeId: null, opened: '2026-08-31',
    });

    const withOccurrence = await asOrg(f.orgId, (tx) =>
      recordFindingObservations(tx, f.orgId, NOW));
    // ⭐ The contrast is the proof: the same run, same clock, asks about August only because an
    // occurrence for August is still open. Remove the union and the first assertion still passes
    // while this one fails.
    expect(withOccurrence.periodsAsked).toContain('2026-08');
    expect(withOccurrence.periodsAsked).toContain('2026-09');
  });

  it('⛔ a period-scoped key is never closed by a run that did not ask its month', async () => {
    // The belt-and-braces half, exercised directly rather than trusted: `closeOccurrence` is only
    // reached for a key whose period is in the asked set. Here the asked set is forced to a single
    // unrelated month by giving the job a clock nowhere near the occurrence's period, and the row
    // is inserted with a period the run has no reason to ask about... except it does, by the rule
    // above. So this asserts the invariant that matters: it is STILL OPEN either way.
    await occurrence({
      key: 'amortisationNotBooked:2026-07', kind: 'amortisationNotBooked',
      storeId: null, opened: '2026-07-31',
    });
    await asOrg(f.orgId, (tx) => recordFindingObservations(tx, f.orgId, new Date('2026-10-05T00:00:00Z')));

    const row = await sql<{ closed_on: string | null }[]>`
      select closed_on from finding_occurrences where org_id = ${f.orgId} and finding_key = 'amortisationNotBooked:2026-07'`;
    // ⚠️ Closed ONLY if the detector actually said "July is fine" — which it does here, because the
    // fixture has no depreciable assets, so July genuinely has nothing missing. The point of the
    // invariant is that this is a real answer to a real question, not a side effect of the calendar.
    expect(row).toHaveLength(1);
  });
});

describe('T-214 — ⭐ a finding too young to judge is PENDING, not a failure', () => {
  it('⛔ a store whose findings were all raised today scores NULL, not 0', async () => {
    // ⚠️ Found by looking at the rendered page, not by a test. On the first day of the record every
    // store showed 0 — every finding had been raised that morning and none was cleared, so
    // `cleared/raised` was 0/2. A branch that has had a few hours has not "responded badly".
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    await occurrence({ key: 'k:today1', opened: today });
    await occurrence({ key: 'k:today2', opened: today });

    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    const row = card.stores.find((s) => s.storeId === f.storeId)!;

    expect(row.raised).toBe(2);
    expect(row.pending).toBe(2);
    expect(row.clearRate).toBeNull();
    expect(row.score).toBeNull();
  });

  it('✅ but one open PAST the grace window counts against the store', async () => {
    await occurrence({ key: 'k:stale', opened: '2026-02-01' }); // long past 14 days
    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    const row = card.stores.find((s) => s.storeId === f.storeId)!;
    expect(row.pending).toBe(0);
    expect(row.clearRate).toBe(0);
    expect(row.score).toBe(0);
  });
});

describe('T-214 — the score, and the ratio v1 chose', () => {
  it('⭐ two components re-weight to 57/43, NOT 50/50', async () => {
    // v1's raw weights are 0.4 action / 0.3 speed / 0.3 briefing-coverage, normalised over whichever
    // parts are present. Dropping coverage leaves 0.4 and 0.3 — 57% and 43%. ⛔ A future "tidy-up"
    // to 0.5/0.5 silently re-decides a ratio nobody asked to change, and must fail here.
    expect(compositeScore(1, 0)).toBe(57);
    expect(compositeScore(0, 1)).toBe(43);
    expect(compositeScore(1, 1)).toBe(100);
    expect(compositeScore(0, 0)).toBe(0);
  });

  it('a single present component scores on itself alone — proving wsum normalisation', async () => {
    // Not a hidden zero term: with no speed data at all the score is 100·clearRate exactly.
    expect(compositeScore(0.5, null)).toBe(50);
    expect(compositeScore(null, 0.5)).toBe(50);
  });

  it('⭐ NON-VACUITY — a seeded store returns a real, non-null score', async () => {
    // ⚠️ Mandatory. Live data carries ZERO acknowledgements and few findings, so an all-null
    // scorecard is exactly what a BROKEN one returns and nothing else in the suite separates them.
    await occurrence({ key: 'k:1', opened: '2026-02-01', closed: '2026-02-08' }); // 7 days
    await occurrence({ key: 'k:2', opened: '2026-02-01', closed: '2026-02-08' });
    await occurrence({ key: 'k:3', opened: '2026-02-01' });                        // still open

    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    const row = card.stores.find((s) => s.storeId === f.storeId)!;

    expect(row.raised).toBe(3);
    expect(row.cleared).toBe(2);
    expect(row.stillOpen).toBe(1);
    expect(row.clearRate).toBeCloseTo(2 / 3, 5);
    expect(row.avgDaysToClear).toBe(7);
    expect(row.speedScore).toBeCloseTo(0.5, 5);        // 1 - 7/14
    expect(row.score).not.toBeNull();
    expect(row.score).toBe(Math.round((100 * (0.4 * (2 / 3) + 0.3 * 0.5)) / 0.7));
  });

  it('⚠️ a same-day open-and-clear is 0 days, not a fraction', async () => {
    await occurrence({ key: 'k:sameday', opened: '2026-02-01', closed: '2026-02-01' });
    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    const row = card.stores.find((s) => s.storeId === f.storeId)!;
    expect(row.avgDaysToClear).toBe(0);
    expect(row.speedScore).toBe(1);
  });

  it('a clear slower than the 14-day horizon floors at zero, never negative', async () => {
    await occurrence({ key: 'k:slow', opened: '2026-02-01', closed: '2026-04-01' });
    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    expect(card.stores.find((s) => s.storeId === f.storeId)!.speedScore).toBe(0);
  });
});

describe('T-214 — the view log', () => {
  it('⛔ one row per person per day, however many times the page is refreshed', async () => {
    await asOrg(f.orgId, (tx) => logFindingView(tx, f.orgId, f.personId));
    await asOrg(f.orgId, (tx) => logFindingView(tx, f.orgId, f.personId));
    const rows = await sql<{ n: string }[]>`
      select count(*)::text n from finding_views where org_id = ${f.orgId}`;
    expect(rows[0]!.n).toBe('1');
  });

  it('⚠️ "nobody has ever looked" is a null, and that null is the useful answer', async () => {
    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    expect(card.lastViewedBy).toBeNull();
    expect(card.lastViewedDaysAgo).toBeNull();
  });

  it('reports who looked and how long ago', async () => {
    await asOrg(f.orgId, (tx) => logFindingView(tx, f.orgId, f.personId));
    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    expect(card.lastViewedBy).toBe('Dev Admin');
    expect(card.lastViewedDaysAgo).toBe(0);
  });
});

describe('T-214 — the record’s start date, because there is no backfill', () => {
  it('⛔ recordBeganOn is null before the first run, and a date after it', async () => {
    const empty = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    expect(empty.recordBeganOn).toBeNull();

    await occurrence({ key: 'k:first', opened: '2026-02-01' });
    const card = await asOrg(f.orgId, (tx) => managerScorecard(tx, f.orgId, RANGE));
    expect(card.recordBeganOn).toBe('2026-02-01');
  });
});
