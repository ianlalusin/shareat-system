import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { openingTieOut } from '../../packages/domain/src/cutover/tie-out';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  APP_ROLE,
  BYPASS_ROLE,
  ROLE_PW,
  appSession,
  cli,
  connect,
  dir,
  dropScenarioCopies,
  entry,
  minutesAgo,
  mkOrg,
  newRehearsalDb,
  nonTyingStock,
  openingFigures,
  start,
  step,
  stop,
  urlFor,
  uid,
  writeJournalFile,
  type OrgFx,
} from './t394-s2-fixture';
import postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { journalPath } from '../../scripts/lib/rehearsal/journal';

/**
 * T-394 S2 - `verify` and `verify --after-post` end to end on REAL local rehearsal copies (invariants 8, 9, 10, 10a, 10b, 10c;
 * docs/tasks/394-purge-and-opening-rehearsal.md s4-s6). Written TESTER-FIRST: red until `verify` exists in scripts/cutover-rehearsal.ts
 * (today it answers "usage:" with exit 1, so the exit-0 legs fail on the status and the exit-1 legs fail on the missing named evidence).
 * The fixture sanity tests at the bottom run against the lane DB and are GREEN now: they prove the fixtures do / do not tie
 * (so a red verify test is red for the verify, not for the fixture).
 *
 * ## Pinned CLI contract (the S1 "signatures in the header are the contract" ruling; every point the spec leaves open is chosen here)
 *   npx tsx scripts/cutover-rehearsal.ts verify [--after-post] --confirm-database <db>      env as S1 (REHEARSAL_DATABASE_URL, REHEARSAL_DIR)
 *   - Exit 0 pass, 1 a check failed, 2 refused by a guard (S1). A failed check is printed with the check's name and its evidence:
 *     tie-out -> the store name from the tie-out sentence (tieOutDetail); freeze -> the entry id AND its source_type;
 *     opening set -> the entry id; app role -> the role name; terminal activity -> the table name; sequences -> the sequence name;
 *     DEF-585 -> the organisation id; missing step -> the step code (C2 / C5).
 *   - Check names recorded in the journal's new field `checks: { name, ok, detail, at }[]` (each run replaces the same name):
 *     tie_out, app_role, terminal_activity, fiscal_coverage, sequences_reset (verify) ; opening_set, c2_c5_recorded, freeze, tie_out (--after-post).
 *   - Library (scripts/lib/rehearsal/verify.ts), all take a bypass-RLS postgres.Sql connected to the copy and only READ:
 *       checkAppRole(sql): { ok; roles: string[]; message }            roles = DISTINCT pg_stat_activity.usename of OTHER client sessions
 *       checkTerminalActivity(sql, sinceIso): { ok; failures: { table: string; detail: string }[] }
 *       checkFreeze(sql, purgeCommittedAtIso): { ok; failures: { entryId: string; sourceType: string; detail: string }[] }
 *       checkSequencesReset(sql): { ok; failures: { sequence: string; detail: string }[] }   reads last_value/is_called, NEVER nextval
 *     (the CLI is what these tests exercise; the signatures are named so the builder and the auditor share them).
 *   - `verify` needs the journal's `start.at` (activity "after start") and an app session: a role other than the tool's that is
 *     connected to the copy. `--after-post` also needs `purgeCommittedAt` (the freeze point). Neither requires the other's checks.
 *   - An unusable app role (bypass / no session) is "refused" in the spec's words: accepted here as exit 1 OR 2, never 0 (QUESTION in the hand-back).
 *   - Terminal activity is judged from `start.at`: clock_terminals.created_at / updated_at, attendance_punches.created_at / received_at.
 */

beforeAll(start, 180_000);
afterEach(dropScenarioCopies, 120_000);
afterAll(stop, 300_000);

/** Everything verify records for a copy: the journal (its checks[] carry the evidence) and the full report if one was written. */
const evidence = (db: string): string => {
  const j = journalPath(dir, db);
  const full = path.join(dir, `${db}.full-report.md`);
  return (existsSync(j) ? readFileSync(j, 'utf8') : '') + ' ' + (existsSync(full) ? readFileSync(full, 'utf8') : '');
};

/**
 * The evidence for a failure (an id, a store, a role, a table, a sequence, an organisation) is in the journal's checks[] / the full report,
 * and is NOT in stdout, which carries only a check name, PASS/FAIL and a count (R10 spirit: nothing business-specific on a terminal).
 * `keepOffStdout: false` for short step codes (C2/C5), which are harmless words.
 */
function sees(db: string, r: { text: string }, needle: string, keepOffStdout = true): void {
  expect(evidence(db), `the journal/full report does not carry "${needle}"`).toContain(needle);
  if (keepOffStdout) expect(r.text.includes(needle), `stdout leaks "${needle}"`).toBe(false);
}

const refused = (r: { status: number | null }): boolean => r.status === 1 || r.status === 2;

/** A copy with one tying org; `fn` seeds more; the journal is written last. Returns the db name and the org. */
async function copy(fn?: (s: postgres.Sql, fx: OrgFx) => Promise<void>, j: Parameters<typeof writeJournalFile>[1] = {}): Promise<{ db: string; fx: OrgFx }> {
  const db = await newRehearsalDb();
  const s = connect(db);
  try {
    const fx = await mkOrg(s);
    if (fn) await fn(s, fx);
    writeJournalFile(db, j);
    return { db, fx };
  } finally {
    await s.end({ timeout: 5 });
  }
}

async function verify(db: string, args: string[] = [], env: Record<string, string | undefined> = {}, app: string | null = APP_ROLE) {
  const sess = app ? await appSession(db, app) : null;
  try {
    return cli(['verify', ...args], db, env);
  } finally {
    await sess?.end();
  }
}

describe('T-394 S2 I8 - verify runs openingTieOut for EVERY org', () => {
  it('8.a a tying copy passes, exit 0 (the control: red now only because verify does not exist)', async () => {
    const { db } = await copy(async (s, fx) => {
      await openingFigures(s, fx, ['draft', 'draft']);
    });
    const r = await verify(db);
    expect(r.status, r.text.slice(-800)).toBe(0);
  }, 120_000);

  it('8.b two orgs, BOTH with a non-tying line: exit 1 and both stores are named (mutant: first org only)', async () => {
    const { db, fx } = await copy(async (s, a) => {
      await nonTyingStock(s, a, 'draft');
    });
    const s = connect(db);
    let other: OrgFx;
    try {
      other = await mkOrg(s);
      await nonTyingStock(s, other, 'draft');
    } finally {
      await s.end({ timeout: 5 });
    }
    const r = await verify(db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    // stdout carries only the check name, PASS/FAIL and a count: one non-tying line per org = 2 (first org only would say 1)
    expect(r.text, 'both orgs must be counted (first org only?)').toMatch(/FAIL tie_out[^\n]*\b2\b/);
    for (const leak of [fx.storeName, other.storeName, '75.00', '₱']) expect(r.text.includes(leak), `stdout leaks "${leak}"`).toBe(false);
  }, 120_000);

  it('8.c the second org alone is bad: still exit 1 (whatever order the orgs come in)', async () => {
    const { db } = await copy();
    const s = connect(db);
    let bad: OrgFx;
    try {
      bad = await mkOrg(s);
      await nonTyingStock(s, bad, 'draft');
      const n = (await s<{ n: number }[]>`select count(*)::int as n from organizations`)[0]!.n;
      expect(n).toBeGreaterThanOrEqual(2);
    } finally {
      await s.end({ timeout: 5 });
    }
    const r = await verify(db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    expect(r.text).toMatch(/FAIL tie_out[^\n]*\b1\b/);
    expect(r.text.includes(bad.storeName), 'stdout leaks a store name').toBe(false);
  }, 120_000);
});

describe('T-394 S2 DEF-585 again - verify re-runs the fiscal coverage check', () => {
  it('an org with no open fiscal periods fails verify, naming the org (exit 1)', async () => {
    const { db } = await copy();
    const s = connect(db);
    let orgId = '';
    try {
      orgId = (await mkOrg(s, { periods: false })).orgId;
    } finally {
      await s.end({ timeout: 5 });
    }
    writeJournalFile(db);
    const r = await verify(db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    sees(db, r, orgId);
  }, 120_000);
});

describe('T-394 S2 I10b - the app role is read from pg_stat_activity.usename', () => {
  it('10b.a an app session whose role has BYPASSRLS fails verify, naming the role', async () => {
    const { db } = await copy();
    const r = await verify(db, [], {}, BYPASS_ROLE);
    expect(refused(r), `${r.status}\n${r.text.slice(-600)}`).toBe(true);
    sees(db, r, BYPASS_ROLE);
  }, 120_000);

  it('10b.b no app session at all fails verify (nothing is proving the app\'s role)', async () => {
    const { db } = await copy();
    const r = await verify(db, [], {}, null);
    expect(refused(r), `${r.status}\n${r.text.slice(-600)}`).toBe(true);
    expect(r.text + evidence(db), 'must say why, not print the usage').toMatch(/session/i);
  }, 120_000);

  it('10b.c the role is the session\'s, not the tool\'s: a DATABASE_URL naming the BYPASS role does not fail an app that runs as the plain role (mutant: parsed from DATABASE_URL)', async () => {
    const { db } = await copy();
    const r = await verify(db, [], { DATABASE_URL: urlFor('t394_s2_decoy', BYPASS_ROLE, ROLE_PW), SYSTEM_DATABASE_URL: urlFor('t394_s2_decoy2', BYPASS_ROLE, ROLE_PW) }, APP_ROLE);
    expect(r.status, r.text.slice(-600)).toBe(0);
  }, 120_000);

  it('10b.d ... and a DATABASE_URL naming the PLAIN role does not rescue an app that runs as the bypass role (mutant: parsed from DATABASE_URL)', async () => {
    const { db } = await copy();
    const r = await verify(db, [], { DATABASE_URL: urlFor('t394_s2_decoy', APP_ROLE, ROLE_PW), SYSTEM_DATABASE_URL: urlFor('t394_s2_decoy2', APP_ROLE, ROLE_PW) }, BYPASS_ROLE);
    expect(refused(r), `${r.status}\n${r.text.slice(-600)}`).toBe(true);
    sees(db, r, BYPASS_ROLE);
  }, 120_000);

  it('10b.e the tool\'s own session never counts as the app (mutant: current_user of the tool\'s connection): the tool is a bypass role and a plain app still passes', async () => {
    const { db } = await copy();
    const r = await verify(db);
    expect(r.status, r.text.slice(-600)).toBe(0);
  }, 120_000);
});

describe('T-394 S2 I10c - verify fails when terminals were touched after start', () => {
  const since = () => minutesAgo(60);

  async function withEmployment(s: postgres.Sql, fx: OrgFx): Promise<string> {
    const [e] = await s<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${fx.orgId}, ${fx.storeId}, ${fx.personId}, ${uid('SC')}, 'regular', '2026-01-01') returning id`;
    return e!.id;
  }

  it('10c.a a clock_terminals row created after start fails, naming the table', async () => {
    const { db } = await copy(async (s, fx) => {
      await s`insert into clock_terminals (org_id, store_id, label, firebase_uid) values (${fx.orgId}, ${fx.storeId}, 'T1', ${uid('fb')})`;
    });
    const r = await verify(db);
    expect(r.status, r.text.slice(-600)).toBe(1);
    sees(db, r, 'clock_terminals');
  }, 120_000);

  it('10c.b a terminal that existed before start but was UPDATED after it fails (created_at alone is not enough)', async () => {
    const { db } = await copy(async (s, fx) => {
      await s`insert into clock_terminals (org_id, store_id, label, firebase_uid, created_at) values (${fx.orgId}, ${fx.storeId}, 'T1', ${uid('fb')}, ${minutesAgo(600)}::timestamptz)`;
      await s`update clock_terminals set updated_at = now(), label = 'T1 renamed' where org_id = ${fx.orgId}`;
    });
    const r = await verify(db);
    expect(r.status, r.text.slice(-600)).toBe(1);
    sees(db, r, 'clock_terminals');
  }, 120_000);

  it('10c.c an attendance_punches row inserted after start fails, naming the table (mutant: clock_terminals only)', async () => {
    const { db } = await copy(async (s, fx) => {
      const emp = await withEmployment(s, fx);
      await s`
        insert into attendance_punches (org_id, store_id, person_id, employment_id, client_punch_id, occurred_at, shift_day, method, asserted_intent, source)
        values (${fx.orgId}, ${fx.storeId}, ${fx.personId}, ${emp}, ${uid('cp')}, now(), current_date, 'manual', 'in', 'manual_entry')`;
    });
    const r = await verify(db);
    expect(r.status, r.text.slice(-600)).toBe(1);
    sees(db, r, 'attendance_punches');
  }, 120_000);

  it('10c.d the control: a terminal and a punch that both predate start pass (the check is "after start", not "any")', async () => {
    const { db } = await copy(async (s, fx) => {
      const old = minutesAgo(600);
      await s`insert into clock_terminals (org_id, store_id, label, firebase_uid, created_at) values (${fx.orgId}, ${fx.storeId}, 'T1', ${uid('fb')}, ${old}::timestamptz)`;
      const emp = await withEmployment(s, fx);
      await s`
        insert into attendance_punches (org_id, store_id, person_id, employment_id, client_punch_id, occurred_at, shift_day, method, asserted_intent, source, received_at, created_at)
        values (${fx.orgId}, ${fx.storeId}, ${fx.personId}, ${emp}, ${uid('cp')}, ${old}::timestamptz, current_date, 'manual', 'in', 'manual_entry', ${old}::timestamptz, ${old}::timestamptz)`;
    }, { startAt: since() });
    const r = await verify(db);
    expect(r.status, r.text.slice(-600)).toBe(0);
  }, 120_000);

  it('10c.e verify --after-post applies the same terminal check', async () => {
    const { db } = await copy(async (s, fx) => {
      await openingFigures(s, fx);
      await step(s, fx, 'C2');
      await step(s, fx, 'C5');
      await s`insert into clock_terminals (org_id, store_id, label, firebase_uid) values (${fx.orgId}, ${fx.storeId}, 'T1', ${uid('fb')})`;
    });
    const r = await verify(db, ['--after-post']);
    expect(r.status, r.text.slice(-600)).toBe(1);
    sees(db, r, 'clock_terminals');
  }, 120_000);
});

describe('T-394 S2 I10a - the first document after the purge gets number 1 (sequences are READ, never consumed)', () => {
  it('10a.a a purge-owned sequence that has been advanced fails, naming it', async () => {
    const { db } = await copy(async (s) => {
      await s`select nextval('mirror_outbox_id_seq')`;
    });
    const r = await verify(db);
    expect(r.status, r.text.slice(-600)).toBe(1);
    sees(db, r, 'mirror_outbox_id_seq');
  }, 120_000);

  it('10a.b verify twice on an untouched copy passes both times and leaves the sequence uncalled (mutant: nextval consumes a number and reports 2)', async () => {
    const { db } = await copy();
    const a = await verify(db);
    const b = await verify(db);
    expect(a.status, a.text.slice(-500)).toBe(0);
    expect(b.status, b.text.slice(-500)).toBe(0);
    const s = connect(db);
    try {
      const [q] = await s<{ is_called: boolean; last_value: string }[]>`select is_called, last_value::text from mirror_outbox_id_seq`;
      expect(q!.is_called, 'verify consumed a number (nextval)').toBe(false);
    } finally {
      await s.end({ timeout: 5 });
    }
  }, 120_000);
});

describe('T-394 S2 I9 - verify --after-post: the opening is the SET of opening_balance entries', () => {
  const after = (db: string, env: Record<string, string | undefined> = {}) => verify(db, ['--after-post'], env);

  it('9.a two posted opening entries dated the conversion date, C2 and C5 recorded: exit 0 (the control)', async () => {
    const { db } = await copy(async (s, fx) => {
      await openingFigures(s, fx);
      await step(s, fx, 'C2');
      await step(s, fx, 'C5');
    });
    const r = await after(db);
    expect(r.status, r.text.slice(-800)).toBe(0);
  }, 120_000);

  for (const draftIndex of [0, 1]) {
    it(`9.b entry #${draftIndex + 1} of the set left as a draft fails, naming its id (mutants: only the first considered; a draft passes)`, async () => {
      let ids: string[] = [];
      const { db } = await copy(async (s, fx) => {
        ids = await openingFigures(s, fx, draftIndex === 0 ? ['draft', 'posted'] : ['posted', 'draft']);
        await step(s, fx, 'C2');
        await step(s, fx, 'C5');
      });
      const r = await after(db);
      expect(r.status, r.text.slice(-800)).toBe(1);
      sees(db, r, ids[draftIndex]!);
    }, 120_000);
  }

  it('9.c a posted opening entry dated 2027-01-02 fails, naming its id (every one must be dated CONVERSION_DATE)', async () => {
    let id = '';
    const { db } = await copy(async (s, fx) => {
      await openingFigures(s, fx);
      id = await entry(s, fx, { date: '2027-01-02', source: 'opening_balance', status: 'posted', lines: [{ code: '1130', debit: '10.00', credit: '0', storeId: fx.storeId }, { code: '3300', debit: '0', credit: '10.00', storeId: fx.storeId }] });
      await step(s, fx, 'C2');
      await step(s, fx, 'C5');
    });
    const r = await after(db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    sees(db, r, id);
  }, 120_000);

  it('9.d a balanced posted opening entry that openingTieOut refuses fails (mutant: Σdebit = Σcredit re-computed in the tool)', async () => {
    const { db, fx } = await copy(async (s, f) => {
      await openingFigures(s, f);
      await nonTyingStock(s, f, 'posted');
      await step(s, f, 'C2');
      await step(s, f, 'C5');
    });
    const r = await after(db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    expect(r.text).toMatch(/FAIL tie_out/);
    expect(r.text.includes(fx.storeName), 'stdout leaks a store name').toBe(false);
  }, 120_000);

  it('9.e a SECOND org with a draft opening entry fails, naming it, though the first org is fine (mutant: first org only)', async () => {
    let badId = '';
    const { db } = await copy(async (s, fx) => {
      await openingFigures(s, fx);
      await step(s, fx, 'C2');
      await step(s, fx, 'C5');
      const o2 = await mkOrg(s);
      badId = (await openingFigures(s, o2, ['posted', 'draft']))[1]!;
      await step(s, o2, 'C2');
      await step(s, o2, 'C5');
    });
    const r = await after(db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    sees(db, r, badId);
  }, 120_000);

  it('9.f no opening_balance entry at all fails (nothing was posted)', async () => {
    const { db } = await copy(async (s, fx) => {
      await step(s, fx, 'C2');
      await step(s, fx, 'C5');
    });
    const r = await after(db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    expect(r.text + evidence(db), 'must say why').toMatch(/opening/i);
  }, 120_000);

  for (const missing of ['C2', 'C5'] as const) {
    it(`9.g no ${missing} row in cutover_steps fails, naming ${missing}`, async () => {
      const { db } = await copy(async (s, fx) => {
        await openingFigures(s, fx);
        if (missing !== 'C2') await step(s, fx, 'C2');
        if (missing !== 'C5') await step(s, fx, 'C5');
      });
      const r = await after(db);
      expect(r.status, r.text.slice(-800)).toBe(1);
      sees(db, r, missing, false);
    }, 120_000);
  }
});

describe('T-394 S2 I10 - R13 freeze: judged by creation time against the purge commit, whatever the entry_date', () => {
  const after = (db: string) => verify(db, ['--after-post']);
  const ready = async (s: postgres.Sql, fx: OrgFx): Promise<void> => {
    await openingFigures(s, fx);
    await step(s, fx, 'C2');
    await step(s, fx, 'C5');
  };

  it('10.a a manual journal created AFTER the purge but dated 2026-12-31 fails, naming its id and source (mutant: compared by entry_date)', async () => {
    let id = '';
    const { db } = await copy(async (s, fx) => {
      await ready(s, fx);
      id = await entry(s, fx, { date: '2026-12-31', source: 'manual_journal', status: 'posted', lines: [{ code: '1110', debit: '5.00', credit: '0' }, { code: '3300', debit: '0', credit: '5.00' }] });
    });
    const r = await after(db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    sees(db, r, id);
    sees(db, r, 'manual_journal');
  }, 120_000);

  it('10.b ... and one dated after the conversion, created after the purge, fails too', async () => {
    let id = '';
    const { db } = await copy(async (s, fx) => {
      await ready(s, fx);
      id = await entry(s, fx, { date: '2027-01-05', source: 'sales_receipt', status: 'draft', lines: [{ code: '1110', debit: '5.00', credit: '0' }, { code: '3300', debit: '0', credit: '5.00' }] });
    });
    const r = await after(db);
    expect(r.status, r.text.slice(-800)).toBe(1);
    sees(db, r, id);
    sees(db, r, 'sales_receipt');
  }, 120_000);

  it('10.c the control: a non-opening entry created BEFORE the purge commit, dated 2027-01-05, passes (the test is creation time, not date)', async () => {
    const { db } = await copy(async (s, fx) => {
      await ready(s, fx);
      await entry(s, fx, { date: '2027-01-05', source: 'manual_journal', status: 'posted', createdAt: minutesAgo(120), lines: [{ code: '1110', debit: '5.00', credit: '0' }, { code: '3300', debit: '0', credit: '5.00' }] });
    });
    const r = await after(db);
    expect(r.status, r.text.slice(-800)).toBe(0);
  }, 120_000);

  it('10.d opening_balance entries created after the purge are NOT a breach (C5 is the one thing allowed to post)', async () => {
    const { db } = await copy(async (s, fx) => {
      await ready(s, fx);
    });
    const r = await after(db);
    expect(r.status, r.text.slice(-800)).toBe(0);
  }, 120_000);
});

describe('T-394 S2 - verify records its checks in the journal for the report', () => {
  it('after a failing verify the journal carries a tie_out check with ok=false', async () => {
    const { db } = await copy(async (s, fx) => {
      await nonTyingStock(s, fx, 'draft');
    });
    const r = await verify(db);
    expect(r.status, r.text.slice(-500)).toBe(1);
    const { readFileSync } = await import('node:fs');
    const { journalPath } = await import('../../scripts/lib/rehearsal/journal');
    const { dir } = await import('./t394-s2-fixture');
    const j = JSON.parse(readFileSync(journalPath(dir, db), 'utf8')) as { checks?: { name: string; ok: boolean }[] };
    const c = (j.checks ?? []).find((x) => x.name === 'tie_out');
    expect(c, `no tie_out in journal.checks: ${JSON.stringify(j.checks)}`).toBeTruthy();
    expect(c!.ok).toBe(false);
  }, 120_000);
});

// ----------------------------------------------------------------------------------------------------- fixture sanity (GREEN now)

describe('T-394 S2 fixture sanity (on its OWN clone, never the lane DB): the passing fixtures tie and the failing one does not', () => {
  it('openingFigures (posted and draft) hold; a stock opening entry for a store with no counts does not', async () => {
    const db = await newRehearsalDb();
    const raw = connect(db);
    try {
      const tie = (orgId: string) => drizzle(raw).transaction((tx) => openingTieOut(tx as never, orgId));
      const good = await mkOrg(raw);
      await openingFigures(raw, good);
      const t1 = await tie(good.orgId);
      expect(t1.holds, t1.lines.map((l) => l.sentence).join(' / ')).toBe(true);

      const bad = await mkOrg(raw);
      await nonTyingStock(raw, bad, 'posted');
      const t2 = await tie(bad.orgId);
      expect(t2.holds).toBe(false);
      expect(t2.lines.length, 'the 8.b/8.c counts rely on ONE line per non-tying org').toBe(1);
      expect(t2.lines.map((l) => l.sentence).join(' ')).toContain(bad.storeName);
    } finally {
      await raw.end({ timeout: 5 });
    }
  }, 120_000);
});

describe('T-394 S2 - nothing business-specific reaches the stdout of verify; zero organisations is a failure', () => {
  it('stdout sentinel: a counted item name, a store name and a peso amount from the failing tie-out never appear; the check name, FAIL and a count do', async () => {
    const SENT = 'SENTINELITEM' + uid('x');
    const { db, fx } = await copy(async (s, f) => {
      await nonTyingStock(s, f, 'draft');
      await s`update stores set name = ${'SENTINELSTORE ' + SENT} where id = ${f.storeId}`;
    });
    void fx;
    const r = await verify(db);
    expect(r.status, r.text.slice(-500)).toBe(1);
    for (const leak of ['SENTINELSTORE', SENT, '75.00', '₱']) expect(r.text.includes(leak), `stdout leaks "${leak}"`).toBe(false);
    expect(r.text).toMatch(/FAIL tie_out[^\n]*\b1\b/);
  }, 120_000);

  for (const args of [[], ['--after-post']]) {
    it(`zero organisations: verify ${args.join(' ')} FAILS, it is not a vacuous pass`, async () => {
      const { db } = await copy();
      const s = connect(db);
      try {
        await s`truncate organizations cascade`;
      } finally {
        await s.end({ timeout: 5 });
      }
      writeJournalFile(db);
      const r = await verify(db, args);
      expect(r.status, r.text.slice(-500)).toBe(1);
      expect(r.text + evidence(db)).toMatch(/organi[sz]ation/i);
    }, 120_000);
  }
});

describe('T-394 S2 - mark refuses a step code that is not a step code', () => {
  it('mark "call Maria" start is refused (exit 1 or 2) and writes nothing to the journal; mark C3 start still works', async () => {
    const { db } = await copy();
    const bad = cli(['mark', 'call Maria', 'start'], db);
    expect([1, 2], `${bad.status}
${bad.text.slice(-400)}`).toContain(bad.status);
    expect(bad.text).not.toContain('usage: cutover-rehearsal <start');
    const { readFileSync } = await import('node:fs');
    const { journalPath } = await import('../../scripts/lib/rehearsal/journal');
    const { dir } = await import('./t394-s2-fixture');
    const before = JSON.parse(readFileSync(journalPath(dir, db), 'utf8')) as { steps: { code: string }[] };
    expect(before.steps.map((x) => x.code)).not.toContain('call Maria');
    const ok = cli(['mark', 'C3', 'start'], db);
    expect(ok.status, ok.text.slice(-400)).toBe(0);
    const after = JSON.parse(readFileSync(journalPath(dir, db), 'utf8')) as { steps: { code: string }[] };
    expect(after.steps.map((x) => x.code)).toContain('C3');
  }, 120_000);
});
