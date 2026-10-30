import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-373 S2 (DEF-559) — a finding per store pair. `docs/tasks/373-money-follow-ups.md` §S2, T1-T7.
 *
 * `reciprocalDrift` sums 1250 and 2150 over the whole org, so two pairs out of step by +X and -X net to zero and stay silent.
 * S2 adds `interStorePairOutOfStep` (one per unordered pair whose two books disagree) and `interStoreLineUnmatched` (one
 * org-wide, for 1250/2150 lines no pair can read), both `hard`.
 *
 * TESTER. Every FIRING leg is red on HEAD (no such kind). Every "does not fire" leg has a positive control in the same
 * test (the line exists, the real posting is there, the mismatch is only on the other side) so a detector that never fires
 * cannot pass it. Seeding: real writers (`createMoneyTransfer`, `settleBetweenStores`, `voidMoneyTransfer`) for the debt;
 * the out-of-step shapes by an in-test one-sided balanced entry (S9·T9's method).
 *
 * ASSUMED (spec leaves open; assertions are deliberately loose on these):
 *   - the sentence's store ORDER and the sign of a negative figure (A < B by id, "A's books say A owes B x"); detail asserts
 *     are on the names and the two figures, not their order.
 *   - "worth X" for the unmatched finding is read as the sum of the lines' amounts (one line: its amount).
 *
 * MUTANTS: ordered-pair grouping -> T2; JS `Math.abs(x) < 0.005` -> T7; include drafts -> T4; drop own-store condition -> T5 own-store leg.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { closeReadiness, createMoneyTransfer, listFindings, seedAttendanceConfig, settleBetweenStores, voidMoneyTransfer } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';
import { reverseEntry } from '../../src/ledger/reverse-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const DATE = '2026-01-16';
const PERIOD = '2026-01';
const PAIR = 'interStorePairOutOfStep';
const UNMATCHED = 'interStoreLineUnmatched';

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

interface Account { id: string; glCode: string; storeId: string }
async function foundation(storeId: string): Promise<Account> {
  const [row] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  if (!row) throw new Error(`fixture: no foundation office safe at ${storeId}`);
  return { id: row.id, glCode: row.gl_account_code, storeId };
}

async function fixture(hint: string) {
  const code = uid(`t373s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const store = async (name: string) => {
    const c = uid(name.toLowerCase());
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${c}, ${name}, '2020-01-01') returning id`;
    return { id: s!.id, code: c, name };
  };
  const lipa = await store('Lipa');
  const malvar = await store('Malvar');
  const comm = await store('Commissary');
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  for (const s of [lipa, malvar, comm]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s.id})`;
  const adminId = p!.id;
  const acct = { lipaSafe: await foundation(lipa.id), malvarSafe: await foundation(malvar.id), commSafe: await foundation(comm.id) };
  for (const a of Object.values(acct)) {
    await asOrg(orgId, (tx) =>
      postEntry(tx, {
        orgId, entryDate: '2026-01-01', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
        lines: [{ accountCode: a.glCode, storeId: a.storeId, debit: '100000.00' }, { accountCode: '3300', storeId: a.storeId, credit: '100000.00' }],
      }),
    );
  }
  return { orgId, lipa, malvar, comm, ...acct, admin: actor(orgId, adminId), adminId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** An ordinary cross-store transfer `from` -> `to`: the SOURCE store gets DR 1250, the DESTINATION CR 2150. malvarSafe -> lipaSafe: Lipa owes Malvar. */
const transfer = (f: Fixture, from: Account, to: Account, amount: string) =>
  asOrg(f.orgId, (tx) => createMoneyTransfer(tx, f.admin, { requestId: crypto.randomUUID(), fromMoneyAccountId: from.id, toMoneyAccountId: to.id, amountOut: amount, amountIn: amount, transferDate: DATE }));

type StoreRef = { id: string; code: string };
interface OneSided {
  code: '1250' | '2150';
  at: StoreRef;
  party?: { code: string };
  partyType?: string;
  side: 'debit' | 'credit';
  amount: string;
  noStore?: boolean;
}
/** A balanced entry whose counter-leg is NOT a 1250/2150 line, so it posts one side of an inter-store relationship only. */
async function oneSided(f: Fixture, l: OneSided, opts: { draft?: boolean } = {}): Promise<any> {
  const counter = l.side === 'debit' ? 'credit' : 'debit';
  if (!opts.draft) {
    return asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-01-10', sourceType: 'manual_journal', sourceId: uid('one'), idempotencyKey: uid('one'), memo: 'fixture one-sided inter-store', postedBy: f.adminId,
        lines: [
          {
            accountCode: l.code,
            ...(l.noStore ? {} : { storeId: l.at.id }),
            [l.side]: l.amount,
            ...(l.party ? { partyType: (l.partyType ?? 'store') as 'store', partyId: l.party.code } : {}),
          },
          { accountCode: '3300', storeId: l.at.id, [counter]: l.amount },
        ],
      }),
    );
  }
  // A DRAFT entry: inserted raw and never flipped to posted.
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} order by starts_on limit 1`;
  const ids = await sql<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${f.orgId} and code in (${l.code}, '3300')`;
  const by = new Map(ids.map((r) => [r.code, r.id]));
  const d = l.side === 'debit' ? l.amount : '0';
  const c = l.side === 'credit' ? l.amount : '0';
  const e = await sql.begin(async (t) => {
    const [row] = await t<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-10', ${period!.id}, 'manual_journal', ${uid('draft')}, 'draft') returning id`;
    await t`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${row!.id}, 1, ${by.get(l.code)!}, ${l.at.id}, ${d}, ${c}, ${l.party ? 'store' : null}, ${l.party?.code ?? null})`;
    await t`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${row!.id}, 2, ${by.get('3300')!}, ${l.at.id}, ${c}, ${d})`;
    return row!;
  });
  return e!.id;
}

const feed = (f: Fixture) => asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
const ofKind = async (f: Fixture, kind: string) => (await feed(f)).findings.filter((x) => x.kind === kind);
const ledgerLines = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`
    select count(*)::text as n from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code in ('1250','2150')`)[0]!.n);
const pairKey = (a: StoreRef, b: StoreRef) => `${PAIR}:${[a.id, b.id].sort().join(':')}`;
/** The DEFECT state: Lipa/Malvar +250 (Lipa says 650, Malvar says 400) and Lipa/Commissary -250 (Lipa is owed 250 by Commissary, Commissary's books are silent). Σ1250 = Σ2150. */
async function defectState(f: Fixture) {
  await transfer(f, f.malvarSafe, f.lipaSafe, '400.00'); // real: both books say Lipa owes Malvar 400
  await oneSided(f, { code: '2150', at: f.lipa, party: f.malvar, side: 'credit', amount: '250.00' }); // Lipa alone: 650
  await oneSided(f, { code: '1250', at: f.lipa, party: f.comm, side: 'debit', amount: '250.00' }); // Lipa alone: Commissary owes Lipa 250
}

describe('T1 — the defect: two pairs out of step by +250 and -250 net to zero org-wide', () => {
  it('exactly two interStorePairOutOfStep findings with the right keys, hard, both figures; dueFromDueToNotReciprocal stays silent (the very blind spot)', async () => {
    const f = await fixture('t1');
    await defectState(f);
    const all = (await feed(f)).findings;
    // control: the org-wide check really is blind here, so the new kind is the only thing that can see it
    expect(all.some((x) => x.kind === 'dueFromDueToNotReciprocal'), 'fixture: Σ1250 must equal Σ2150').toBe(false);
    expect(await ledgerLines(f.orgId), 'fixture: 1250/2150 lines exist').toBeGreaterThan(0);

    const pairs = all.filter((x) => x.kind === PAIR);
    expect(pairs.map((x) => x.key).sort()).toEqual([pairKey(f.lipa, f.malvar), pairKey(f.lipa, f.comm)].sort());
    for (const p of pairs) {
      expect(p.severity).toBe('hard');
      expect(p.storeId).toBeNull();
    }
    const lm = pairs.find((x) => x.key === pairKey(f.lipa, f.malvar))!;
    expect(lm.detail).toContain('Lipa');
    expect(lm.detail).toContain('Malvar');
    expect(lm.detail).toContain('₱650.00');
    expect(lm.detail).toContain('₱400.00');
    expect(lm.detail).toMatch(/inter-store posting is missing on one side/);
    const lc = pairs.find((x) => x.key === pairKey(f.lipa, f.comm))!;
    expect(lc.detail).toContain('Lipa');
    expect(lc.detail).toContain('Commissary');
    // Commissary < Lipa by code; Lipa's books say Commissary owes Lipa 250, Commissary's say nothing
    expect(lc.detail).toBe("Commissary's books say nothing is owed, but Lipa's books say Commissary owes Lipa ₱250.00. An inter-store posting is missing on one side.");
    expect(all.some((x) => x.kind === UNMATCHED), 'every line here names a real pair of stores').toBe(false);
  });
});

describe('T2 — positive control: real postings never fire', () => {
  it('a cross-store transfer, a partial settlement and a voided transfer (an ordered-pair grouping would fire on the first)', async () => {
    const f = await fixture('t2');
    await transfer(f, f.malvarSafe, f.lipaSafe, '650.00'); // Lipa owes Malvar 650
    expect(await ledgerLines(f.orgId), 'control: the transfer posted 1250/2150 lines').toBeGreaterThanOrEqual(2);
    expect(await ofKind(f, PAIR), 'a real transfer').toEqual([]);
    await asOrg(f.orgId, (tx) =>
      settleBetweenStores(tx, f.admin, {
        settlementId: crypto.randomUUID(), fromMoneyAccountId: f.lipaSafe.id, toMoneyAccountId: f.malvarSafe.id, amountOut: '200.00', amountIn: '200.00', transferDate: DATE,
      }),
    );
    expect(await ofKind(f, PAIR), 'after a settlement').toEqual([]);
    const second = await transfer(f, f.commSafe, f.lipaSafe, '300.00');
    await asOrg(f.orgId, (tx) => voidMoneyTransfer(tx, f.admin, { moneyTransferId: second.id, reason: 'Wrong day' }));
    expect(await ofKind(f, PAIR), 'after a voided transfer').toEqual([]);
    expect(await ofKind(f, UNMATCHED)).toEqual([]);
  });
});

describe('T3 — direction: the key is the unordered pair', () => {
  it("the same mismatch posted from Malvar's side raises the same pair key; a Lipa-side extra 250 matched by a Malvar-side extra 250 stays in step", async () => {
    const f = await fixture('t3');
    await transfer(f, f.malvarSafe, f.lipaSafe, '400.00');
    // Malvar's books alone say Lipa owes 650 (extra DR 1250 at Malvar, party Lipa); Lipa's say 400.
    await oneSided(f, { code: '1250', at: f.malvar, party: f.lipa, side: 'debit', amount: '250.00' });
    const found = await ofKind(f, PAIR);
    expect(found.map((x) => x.key)).toEqual([pairKey(f.lipa, f.malvar)]);
    expect(found[0]!.detail).toContain('₱650.00');
    expect(found[0]!.detail).toContain('₱400.00');

    // the same figures posted from Lipa's side, in a second org: same shape of key
    const g = await fixture('t3b');
    await transfer(g, g.malvarSafe, g.lipaSafe, '400.00');
    await oneSided(g, { code: '2150', at: g.lipa, party: g.malvar, side: 'credit', amount: '250.00' });
    expect((await ofKind(g, PAIR)).map((x) => x.key)).toEqual([pairKey(g.lipa, g.malvar)]);

    // control: Lipa now carries the extra 250 too, so both books say 650 and the pair is back in step
    await oneSided(f, { code: '2150', at: f.lipa, party: f.malvar, side: 'credit', amount: '250.00' });
    expect(await ofKind(f, PAIR), 'both sides now carry the extra 250').toEqual([]);
  });
});

describe('T4 — drafts are not books', () => {
  it('a one-sided DRAFT entry raises nothing; the same entry posted raises the pair finding (control)', async () => {
    const f = await fixture('t4');
    await transfer(f, f.malvarSafe, f.lipaSafe, '400.00');
    await oneSided(f, { code: '2150', at: f.lipa, party: f.malvar, side: 'credit', amount: '250.00' }, { draft: true });
    expect(await ofKind(f, PAIR), 'a draft one-sided entry').toEqual([]);
    expect(await ofKind(f, UNMATCHED)).toEqual([]);
    await oneSided(f, { code: '2150', at: f.lipa, party: f.malvar, side: 'credit', amount: '250.00' });
    expect((await ofKind(f, PAIR)).map((x) => x.key), 'control: posted, it fires').toEqual([pairKey(f.lipa, f.malvar)]);
  });
});

describe('T5 — interStoreLineUnmatched: one leg per way a line can fail to name two different stores', () => {
  const legs: [string, (f: Fixture) => Promise<unknown>][] = [
    ['a party code that names no store', (f) => oneSided(f, { code: '1250', at: f.lipa, party: { code: 'NO-SUCH-STORE' }, side: 'debit', amount: '100.00' })],
    ["the line's own store", (f) => oneSided(f, { code: '2150', at: f.lipa, party: f.lipa, side: 'credit', amount: '100.00' })],
    ["party_type 'customer'", (f) => oneSided(f, { code: '1250', at: f.lipa, party: { code: f.malvar.code }, partyType: 'customer', side: 'debit', amount: '100.00' })],
    ['a null store_id', (f) => oneSided(f, { code: '1250', at: f.lipa, party: f.malvar, side: 'debit', amount: '100.00', noStore: true })],
  ];
  for (const [label, seed] of legs) {
    it(`${label} -> exactly one ${UNMATCHED} (hard) with the count and the amount, and no pair finding`, async () => {
      const f = await fixture('t5');
      await transfer(f, f.malvarSafe, f.lipaSafe, '400.00'); // control: a matched pair beside it does not count
      expect(await ofKind(f, UNMATCHED), 'control: before the bad line').toEqual([]);
      await seed(f);
      const found = await ofKind(f, UNMATCHED);
      expect(found).toHaveLength(1);
      expect(found[0]!.key).toBe(UNMATCHED);
      expect(found[0]!.severity).toBe('hard');
      expect(found[0]!.storeId).toBeNull();
      expect(found[0]!.detail).toMatch(/\b1 due-from\/due-to line/);
      expect(found[0]!.detail).toContain('₱100.00');
      expect(await ofKind(f, PAIR), 'an unreadable line is not a pair').toEqual([]);
    });
  }

  it('two bad lines -> one finding that says 2 and sums them', async () => {
    const f = await fixture('t5n');
    await oneSided(f, { code: '1250', at: f.lipa, party: { code: 'NO-SUCH-STORE' }, side: 'debit', amount: '100.00' });
    await oneSided(f, { code: '2150', at: f.malvar, party: f.malvar, side: 'credit', amount: '50.00' });
    const found = await ofKind(f, UNMATCHED);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/\b2 due-from\/due-to line/);
    expect(found[0]!.detail).toContain('₱150.00');
  });

  it('a NULL-party 1250 line raises subledgerDoesNotMatchControl and NOT interStoreLineUnmatched (one fact, one finding)', async () => {
    const f = await fixture('t5null');
    await sql`update accounts set requires_party = false where org_id = ${f.orgId} and code = '1250'`;
    await oneSided(f, { code: '1250', at: f.lipa, side: 'debit', amount: '100.00' });
    await sql`update accounts set requires_party = true where org_id = ${f.orgId} and code = '1250'`;
    const all = (await feed(f)).findings;
    expect(all.some((x) => x.kind === 'subledgerDoesNotMatchControl'), 'control: the null-party line is seen by its own detector').toBe(true);
    expect(all.some((x) => x.kind === UNMATCHED)).toBe(false);
    expect(all.some((x) => x.kind === PAIR)).toBe(false);
  });
});

describe('T6 — close: the pair findings block the month', () => {
  it("T1's state lists both pair findings in blocking; a clean state blocks nothing and is ready", async () => {
    const clean = await fixture('t6c');
    // everything unrelated to S2 that blocks a fixture: an attendance config per store and forward runway
    for (const s of [clean.lipa, clean.malvar, clean.comm]) {
      await asOrg(clean.orgId, (tx) => seedAttendanceConfig(tx, { orgId: clean.orgId, storeId: s.id, effectiveFrom: '2026-01-01' }));
    }
    const future = new Date(Date.now() + 400 * 86_400_000);
    const starts = new Date(Date.UTC(future.getUTCFullYear(), future.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const ends = new Date(Date.UTC(future.getUTCFullYear(), future.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${clean.orgId}, ${starts}, ${ends}, 'open')`;
    await transfer(clean, clean.malvarSafe, clean.lipaSafe, '400.00');
    const ok = await asOrg(clean.orgId, (tx) => closeReadiness(tx, clean.orgId, PERIOD));
    expect(ok.blocking.map((b) => b.kind), 'control: real postings block nothing').toEqual([]);
    expect(ok.ready).toBe(true);

    const f = await fixture('t6');
    await defectState(f);
    const readiness = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, PERIOD));
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking.filter((b) => b.kind === PAIR)).toHaveLength(2);
  });
});

describe('T7 — precision: SQL numeric, no epsilon', () => {
  it('0.01 out of step fires with both figures; an exact match does not', async () => {
    const f = await fixture('t7');
    await transfer(f, f.malvarSafe, f.lipaSafe, '400.00');
    expect(await ledgerLines(f.orgId), 'control: lines exist').toBeGreaterThanOrEqual(2);
    expect(await ofKind(f, PAIR), 'exact match').toEqual([]);
    await oneSided(f, { code: '2150', at: f.lipa, party: f.malvar, side: 'credit', amount: '0.01' });
    const found = await ofKind(f, PAIR);
    expect(found.map((x) => x.key)).toEqual([pairKey(f.lipa, f.malvar)]);
    expect(found[0]!.detail).toContain('₱400.01');
    expect(found[0]!.detail).toContain('₱400.00');
  });
});

describe('Audit follow-ups', () => {
  it('a bad line and its REVERSAL cancel: reversing the bad posting clears interStoreLineUnmatched', async () => {
    const f = await fixture('af1');
    const posted = await oneSided(f, { code: '1250', at: f.lipa, party: { code: 'NO-SUCH-STORE' }, side: 'debit', amount: '100.00' });
    const found = await ofKind(f, UNMATCHED);
    expect(found, 'control: the bad line fires').toHaveLength(1);
    expect(found[0]!.detail).toContain('₱100.00');
    await asOrg(f.orgId, (tx) => reverseEntry(tx, { entryId: posted.entryId, reason: 'Wrong party', reversalDate: '2026-01-12', reversedBy: f.adminId }));
    expect(await ofKind(f, UNMATCHED), 'bad line + its reversal').toEqual([]);
  });
});
