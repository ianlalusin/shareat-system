import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-187 slice 1 — `distributeServiceCharge`: the discharge path DEF-082 needs.
 * `docs/tasks/187-service-charge-distribution.md` §7 (contract) and §2 (the five rulings).
 *
 * ⭐ §7's five invariants are this file's shape, one describe block each. Invariant 1 (group B)
 * is the one that matters most: a naive org-wide balance query would pass every other case here
 * and fail only that one — so every fixture below gives TWO stores float, never one, and the
 * assertions are on the PAYING store's own line, never a combined total.
 *
 * ⭐ AMENDMENT 1 (system32-df, verified against liabilities/index.ts:148-152 and
 * remittance/index.ts:88-92): §7's literal `(tx, orgId, input)` was the spec defect, not this
 * file. The contract is `(tx: Tx | null, actor: Actor, input)`, exactly as written below.
 *
 * ⭐ AMENDMENT 2: `postEntry` requires `idempotencyKey` and throws without one
 * (ledger/post-entry.ts:117). The builder derives it from the store and the payday — never a
 * timestamp or a random value — so a double-submitted payday posts once, not twice. The
 * "AMENDMENT 2" describe block below is that case.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { postEntry } from '../../src/ledger/post-entry';
// Imported directly from where §8 tells the builder to create it, not from the domain barrel —
// the barrel (the orchestrator's own file) is not wired to it yet, and `postEntry` above is
// already imported the same direct way by every other integration test in this package.
import { distributeServiceCharge } from '../../src/service-charge';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-01-31';

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** A store plus its foundation "Office cash" (1130) account — seeded by the DB trigger the
 *  moment the store row exists (migration 0029), never created by hand here. */
async function addStore(orgId: string, hint: string) {
  const [store] = await sql<{ id: string; name: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`})
    returning id, name`;
  const [officeCash] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${store!.id}
      and gl_account_code = '1130' and custodian = 'office' and is_foundation`;
  if (!officeCash) throw new Error('fixture: "Office cash" was not seeded for the new store.');
  return { id: store!.id, name: store!.name, officeCashId: officeCash.id };
}
type Store = Awaited<ReturnType<typeof addStore>>;

/**
 * ⛔⛔ ROUND 2 — `distributeServiceCharge` now runs `checkDraw` on the PAYING money account
 * itself (the missing-overdraft-guard fix). "Office cash" is custodian 'office', which
 * `money-accounts/overdraft.ts`'s own rule treats as a COMPLETE balance — no overdraft allowance,
 * blocked at zero regardless (bible row 154). Accruing 2160 (via `accrue` below) puts cash into
 * "Cashier cash" (1110), not "Office cash" (1130), so a fixture that never separately funds Office
 * cash would have every payout refused by checkDraw before invariant 1's cap is even reached —
 * which is correct behaviour for checkDraw, and would silently make every cap/ownership assertion
 * in this file pass or fail for the WRONG reason. Funded generously (not exactly matched to any
 * one test's numbers) so checkDraw is never the constraint these tests are actually about.
 */
async function fund(orgId: string, personId: string, storeId: string, accountCode: string, amount: string, key: string) {
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId,
      entryDate: PERIOD_START,
      sourceType: 'manual_journal',
      sourceId: key,
      idempotencyKey: key,
      memo: 'fixture funding — opening cash',
      postedBy: personId,
      lines: [
        { accountCode, storeId, debit: amount },
        { accountCode: '3900', storeId, credit: amount },
      ],
    }),
  );
}

/** Two stores in one org — every invariant here is about telling them apart. */
async function fixture(hint: string) {
  const code = uid(`sc-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${PERIOD_START}, ${PERIOD_END}, 'open')`;
  const storeA = await addStore(orgId, `${hint}-a`);
  const storeB = await addStore(orgId, `${hint}-b`);
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id)
             values (${p!.id}, ${storeA.id}), (${p!.id}, ${storeB.id})`;
  await fund(orgId, p!.id, storeA.id, '1130', '1000000.00', uid('fund-a'));
  await fund(orgId, p!.id, storeB.id, '1130', '1000000.00', uid('fund-b'));
  return { orgId, storeA, storeB, admin: actor(orgId, p!.id), personId: p!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Accrues a service-charge credit at 2160 for ONE store on a given date — the same shape
 *  `routing.ts` posts, built directly rather than through a full sales day (same technique
 *  `findings.test.ts`'s own `serviceCharge` helper uses). */
async function accrue(f: Fixture, store: Store, on: string, amount: string, key: string) {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: on,
      sourceType: 'manual_journal',
      sourceId: key,
      idempotencyKey: key,
      memo: 'fixture accrual',
      postedBy: f.personId,
      lines: [
        { accountCode: '1110', storeId: store.id, debit: amount },
        { accountCode: '2160', storeId: store.id, credit: amount },
      ],
    }),
  );
}

/**
 * ⭐⭐ §5 AMENDMENT — the store's OWN 2160 balance, summed directly from the ledger (credits minus
 * debits, restricted to this store, over non-draft entries — the same formula invariant 1's cap
 * and `serviceChargeFloatAgeing` both use). The RESIDUAL, not the silence: `findings.ts:611`'s
 * `if (balance < 0.005) continue` has no direction, so "no finding" is equally true of a correctly
 * settled float and an OVER-discharged one driven negative — only the exact figure tells them
 * apart.
 */
async function serviceChargeBalance(orgId: string, storeId: string): Promise<number> {
  const [row] = await sql<{ balance: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '2160' and jl.store_id = ${storeId}`;
  return Number(row!.balance);
}

/** Org-wide entry/line counts — the instrument for invariant 3 ("refuse before any write"). A
 *  test that only checks the throw does not test that nothing landed. */
async function ledgerCounts(orgId: string) {
  const [row] = await sql<{ entries: string; lines: string }[]>`
    select
      (select count(*) from journal_entries where org_id = ${orgId})::text as entries,
      (select count(*) from journal_lines jl join journal_entries je on je.id = jl.entry_id
        where je.org_id = ${orgId})::text as lines`;
  return { entries: Number(row!.entries), lines: Number(row!.lines) };
}

/** The most recently POSTED entry for the org, with its lines resolved back to account codes. */
async function newestEntryLines(orgId: string) {
  const [entry] = await sql<{ id: string; entry_date: string }[]>`
    select id, entry_date::text from journal_entries where org_id = ${orgId}
    order by created_at desc, id desc limit 1`;
  if (!entry) throw new Error('newestEntryLines: no journal entry exists for this org.');
  const lines = await sql<
    { account_code: string; store_id: string | null; debit: string; credit: string }[]
  >`
    select a.code as account_code, jl.store_id::text as store_id,
           jl.debit::text as debit, jl.credit::text as credit
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entry!.id} order by jl.line_no`;
  return { entry, lines };
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-187 §7 — the posting: one entry, two lines, both carrying store_id', () => {
  it('⭐ Dr 2160 / Cr the money account, equal amounts, both lines store-scoped, dated paidOn', async () => {
    const f = await fixture('post');
    await accrue(f, f.storeA, '2026-01-05', '1000.00', uid('accrue'));
    const paidOn = '2026-01-20';

    await asOrg(f.orgId, (tx) =>
      distributeServiceCharge(tx, f.admin, {
        storeId: f.storeA.id,
        moneyAccountId: f.storeA.officeCashId,
        amount: '400.00',
        paidOn,
      }),
    );

    const { entry, lines } = await newestEntryLines(f.orgId);
    // ⛔ journal_entries has NO store_id column, deliberately (schema/journal.ts's own header) —
    // "one aggregate entry per store" is expressed on the LINES, so the assertions below are on
    // the lines, never on an entry-level field that does not exist.
    expect(entry.entry_date).toBe(paidOn);
    expect(lines).toHaveLength(2);

    const dr = lines.find((l) => l.account_code === '2160');
    const cr = lines.find((l) => l.account_code === '1130');
    expect(dr).toBeDefined();
    expect(cr).toBeDefined();
    expect(dr!.debit).toBe('400.00');
    expect(dr!.credit).toBe('0.00');
    expect(cr!.credit).toBe('400.00');
    expect(cr!.debit).toBe('0.00');
    expect(dr!.debit).toBe(cr!.credit); // equal amounts
    // ⭐ Both lines carry store_id — this is the whole mechanism the per-store detector (§3) reads.
    expect(dr!.store_id).toBe(f.storeA.id);
    expect(cr!.store_id).toBe(f.storeA.id);
  });
});

describe('T-187 §7 invariant 1 — the cap is that store\'s OWN balance, never the org\'s', () => {
  it('a payout within the store\'s own balance succeeds even though another store holds more', async () => {
    const f = await fixture('cap-own');
    await accrue(f, f.storeA, '2026-01-01', '300.00', uid('a1'));
    await accrue(f, f.storeB, '2026-01-01', '5000.00', uid('b1'));

    await asOrg(f.orgId, (tx) =>
      distributeServiceCharge(tx, f.admin, {
        storeId: f.storeA.id,
        moneyAccountId: f.storeA.officeCashId,
        amount: '300.00',
        paidOn: '2026-01-10',
      }),
    );

    const { lines } = await newestEntryLines(f.orgId);
    expect(lines.every((l) => l.store_id === f.storeA.id)).toBe(true);
  });

  it('⭐ THE CASE THAT MATTERS MOST — a store must not be able to spend another store\'s float', async () => {
    const f = await fixture('cap-cross');
    // Store A has only 300. Store B has 5000. A naive ORG-WIDE sum (5300) would happily pass a
    // 1000 payout at store A; store A's OWN balance (300) must refuse it.
    await accrue(f, f.storeA, '2026-01-01', '300.00', uid('a2'));
    await accrue(f, f.storeB, '2026-01-01', '5000.00', uid('b2'));
    const before = await ledgerCounts(f.orgId);

    await expect(
      asOrg(f.orgId, (tx) =>
        distributeServiceCharge(tx, f.admin, {
          storeId: f.storeA.id,
          moneyAccountId: f.storeA.officeCashId,
          amount: '1000.00',
          paidOn: '2026-01-10',
        }),
      ),
    ).rejects.toThrow();

    const after = await ledgerCounts(f.orgId);
    // ⛔ Refused before any write — nothing landed anywhere in the org, not even at store B.
    expect(after).toEqual(before);
  });
});

describe('T-187 §7 invariants 2 & 3 — refusal, not clamping, and refused BEFORE any write', () => {
  it('⛔ exceeding the store\'s own cap throws naming the store and the shortfall, and writes nothing', async () => {
    const f = await fixture('refuse');
    // ⚠️ Deliberately NOT "1000 balance, 1500 requested": a round balance makes the shortfall's
    // digits a literal suffix of the requested amount ("1500" contains "500"), so a substring
    // match on the shortfall alone would also match the wrong number. 850 / 1234 keep every
    // figure's digits disjoint from the other two, whatever the message's thousands formatting.
    await accrue(f, f.storeA, '2026-01-01', '850.00', uid('r1'));
    const before = await ledgerCounts(f.orgId);

    let caught: Error | undefined;
    try {
      await asOrg(f.orgId, (tx) =>
        distributeServiceCharge(tx, f.admin, {
          storeId: f.storeA.id,
          moneyAccountId: f.storeA.officeCashId,
          amount: '1234.00', // 384.00 more than the store's 850.00 balance
          paidOn: '2026-01-10',
        }),
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toContain(f.storeA.name);
    // ⛔ The SHORTFALL (384), not the amount requested (1234) or the balance (850) — matching the
    // wrong one is a test that passes while the message misleads. `\b384\b` also survives a
    // thousands-separator: "384" is not a substring of "1,234.00" or "850.00" either way.
    expect(caught!.message).toMatch(/\b384\b/);

    const after = await ledgerCounts(f.orgId);
    // ⛔ Invariant 3 — a test that only checks the throw does not test this. Nothing written,
    // not a draft entry, not a line, not even one that was rolled back partway.
    expect(after).toEqual(before);
  });
});

describe('T-187 AMENDMENT 2 — idempotency: a double-submitted payday does not double-post', () => {
  /**
   * ⛔⛔ ROUND 2 — the defect this describe block's original case COULD NOT see. `postEntry`
   * returns `created: false` on a replayed idempotency key; `distributeServiceCharge` was
   * discarding it, so a replayed payday reported "Distributed." on the operator's screen while
   * posting nothing the second time — cash out of the drawer, no second ledger record, the float
   * left overstated. The case below (same amount, twice) only ever asserted row counts, which stay
   * correct either way — the defect lived entirely in the RETURN VALUE feeding the operator's
   * message, and a test that never reads that value cannot fail when it lies. Assert the output.
   */
  it('⭐ the same amount, twice: the SECOND call reports created: false, and the ledger still shows ONE entry', async () => {
    const f = await fixture('idempotent');
    await accrue(f, f.storeA, '2026-01-01', '1000.00', uid('acc'));
    const before = await ledgerCounts(f.orgId);

    const submit = () =>
      asOrg(f.orgId, (tx) =>
        distributeServiceCharge(tx, f.admin, {
          storeId: f.storeA.id,
          moneyAccountId: f.storeA.officeCashId,
          amount: '400.00',
          paidOn: '2026-01-15',
        }),
      );
    // Two SEPARATE calls (separate transactions, like a retried request actually arrives) —
    // never two inserts inside one transaction, which would not exercise the same idempotency
    // path `postEntry` uses for every other caller.
    const first = await submit();
    expect(first).toMatchObject({ created: true });
    const second = await submit();
    // ⭐ The assertion that was missing. Row counts alone (below) stay identical whether this is
    // true or false — this line is what actually catches the operator-facing lie.
    expect(second).toMatchObject({ created: false });

    const after = await ledgerCounts(f.orgId);
    // Still exactly ONE entry, two lines. Two would record the float as discharged twice when it
    // left the drawer once.
    expect(after.entries - before.entries).toBe(1);
    expect(after.lines - before.lines).toBe(2);
  });

  it('⭐⭐ THE ONE THAT MATTERS — a corrected/second-tranche amount on the SAME store and payday reports created: false and leaves the ORIGINAL amount on the ledger', async () => {
    const f = await fixture('idempotent-diff-amount');
    await accrue(f, f.storeA, '2026-01-01', '2000.00', uid('acc'));
    const before = await ledgerCounts(f.orgId);
    const paidOn = '2026-01-15';

    // The scenario actually reported: ₱400 then ₱600 on ONE payday — not the same amount twice.
    const first = await asOrg(f.orgId, (tx) =>
      distributeServiceCharge(tx, f.admin, {
        storeId: f.storeA.id,
        moneyAccountId: f.storeA.officeCashId,
        amount: '400.00',
        paidOn,
      }),
    );
    expect(first).toMatchObject({ created: true });

    const second = await asOrg(f.orgId, (tx) =>
      distributeServiceCharge(tx, f.admin, {
        storeId: f.storeA.id,
        moneyAccountId: f.storeA.officeCashId,
        amount: '600.00', // same store, same payday, DIFFERENT amount
        paidOn,
      }),
    );
    // ⛔ The defect: this used to be indistinguishable from `first` on the operator's screen.
    expect(second).toMatchObject({ created: false });

    const after = await ledgerCounts(f.orgId);
    // The replay must not have posted a second entry.
    expect(after.entries - before.entries).toBe(1);
    expect(after.lines - before.lines).toBe(2);

    // ⛔ And it must carry the ORIGINAL amount (400), never the replay's (600) — asserting counts
    // alone is precisely how this hid: two entries would have failed the count above, but a
    // SECOND WRITE that silently overwrote the first with 600 would not have.
    const { lines } = await newestEntryLines(f.orgId);
    const dr = lines.find((l) => l.account_code === '2160');
    expect(dr).toBeDefined();
    expect(dr!.debit).toBe('400.00');
  });
});

describe('T-187 §7 invariant 4 — the money account must belong to the paying store', () => {
  it('refuses a payout naming another store\'s money account, and writes nothing', async () => {
    const f = await fixture('wrong-account');
    await accrue(f, f.storeA, '2026-01-01', '1000.00', uid('w1'));
    const before = await ledgerCounts(f.orgId);

    await expect(
      asOrg(f.orgId, (tx) =>
        distributeServiceCharge(tx, f.admin, {
          storeId: f.storeA.id,
          moneyAccountId: f.storeB.officeCashId, // belongs to store B, not the paying store A
          amount: '300.00',
          paidOn: '2026-01-10',
        }),
      ),
    ).rejects.toThrow();

    const after = await ledgerCounts(f.orgId);
    expect(after).toEqual(before);
  });
});

describe('T-187 §5 AMENDMENT — the residual, not just the silence', () => {
  /**
   * ⛔⛔ Why this exists alongside every "no finding" assertion in this file and in
   * findings.test.ts: `serviceChargeFloatAgeing` goes quiet at `balance < 0.005`
   * (packages/db/src/repo/findings.ts:611), which is true for a correctly settled float AND for
   * one over-discharged past zero — the detector has no direction. §5's "the detector goes quiet"
   * done-when is therefore necessary but not sufficient: a distribution that pays out MORE than
   * the float held would ALSO silence it, exactly like a correct one. Silence proves the alarm
   * stopped; only the residual figure proves it stopped for the right reason.
   */
  it('⭐⭐ after a distribution, the store\'s 2160 float lands at the EXACT figure — not merely "no finding"', async () => {
    const f = await fixture('residual');
    await accrue(f, f.storeA, '2026-01-01', '5000.00', uid('seed'));
    expect(await serviceChargeBalance(f.orgId, f.storeA.id)).toBe(5000);

    await asOrg(f.orgId, (tx) =>
      distributeServiceCharge(tx, f.admin, {
        storeId: f.storeA.id,
        moneyAccountId: f.storeA.officeCashId,
        amount: '2000.00',
        paidOn: '2026-01-15',
      }),
    );

    // ⛔ THE RESIDUAL. Not "not.toContain(finding)", not "<= 0" — the number. 5000 seeded, 2000
    // distributed, 3000 must remain; an over-discharge or a double-post would land somewhere else
    // entirely (negative, or short of 3000), and only reading the actual figure catches either.
    expect(await serviceChargeBalance(f.orgId, f.storeA.id)).toBe(3000);
  });
});

describe('T-187 ROUND 2 — checkDraw is a DIFFERENT ceiling from the cap, and both must hold', () => {
  /**
   * ⭐⭐ The cap (invariant 1) asks "does the store owe this to staff" — it is computed from 2160
   * alone. `checkDraw` (added round 2) asks a different question of a different account: "is the
   * cash actually there." A store can genuinely owe ₱5,000 to staff while the safe holds ₱1,200,
   * and only ONE of the two guards catches that. `fixture()` funds Office cash generously
   * (₱1,000,000) so it is never the constraint in the cap/ownership tests above — this describe
   * block exists so that guard is not left completely uncovered by the same fix that made it
   * disappear from every other test's path. Uses a THIRD store, funded by hand, rather than
   * touching `fixture()`'s blanket funding that every other test in this file now relies on.
   */
  it('⛔ ample 2160 float does not excuse an insufficient money account — checkDraw refuses, and nothing is written', async () => {
    const f = await fixture('checkdraw-refuse');
    const storeC = await addStore(f.orgId, 'checkdraw-refuse-c');
    await sql`insert into person_store_scope (person_id, store_id) values (${f.personId}, ${storeC.id})`;
    // The store genuinely OWES this to staff — 5,000 accrued, well past the 3,000 requested.
    await accrue(f, storeC, '2026-01-01', '5000.00', uid('float'));
    // But the safe does not hold it: only 1,000 funded — less than the 3,000 asked for.
    await fund(f.orgId, f.personId, storeC.id, '1130', '1000.00', uid('scant-cash'));
    const before = await ledgerCounts(f.orgId);

    let caught: Error | undefined;
    try {
      await asOrg(f.orgId, (tx) =>
        distributeServiceCharge(tx, f.admin, {
          storeId: storeC.id,
          moneyAccountId: storeC.officeCashId,
          amount: '3000.00', // within the 5,000 cap; over the 1,000 actually in the account
          paidOn: '2026-01-15',
        }),
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(
      caught,
      'the cap passed (5000 owed >= 3000 requested) but the money account could not fund it — this must still refuse',
    ).toBeInstanceOf(Error);
    // ⚠️ Not the exact sentence, matching what identifies THIS refusal rather than the cap's:
    // checkDraw's message names the ACCOUNT ("Office cash"); the cap's own refusal names the STORE.
    expect(caught!.message).toContain('Office cash');

    const after = await ledgerCounts(f.orgId);
    // ⛔ Same discipline as invariant 3 — a guard that throws AFTER writing is the DEF-358 shape,
    // even when the guard itself is a new one the original invariants never named.
    expect(after).toEqual(before);
  });

  /**
   * ⭐ Answers "which direction does checkDraw fail" directly, by trying to construct the wrong
   * kind of refusal: the tightest boundary a strict-inequality bug would misfire on — the account
   * funded with EXACTLY the amount about to be requested. If this test is red, that is a real
   * defect (a store that genuinely holds both the float and the cash, refused anyway) and worth
   * reporting immediately, not adjusting to. Green is the other legitimate answer: tried to make it
   * refuse wrongly and could not.
   */
  it('a store that genuinely holds both the float AND the cash — exactly enough — is not wrongly refused', async () => {
    const f = await fixture('checkdraw-boundary');
    const storeC = await addStore(f.orgId, 'checkdraw-boundary-c');
    await sql`insert into person_store_scope (person_id, store_id) values (${f.personId}, ${storeC.id})`;
    await accrue(f, storeC, '2026-01-01', '5000.00', uid('float'));
    await fund(f.orgId, f.personId, storeC.id, '1130', '3000.00', uid('exact-cash'));

    await asOrg(f.orgId, (tx) =>
      distributeServiceCharge(tx, f.admin, {
        storeId: storeC.id,
        moneyAccountId: storeC.officeCashId,
        amount: '3000.00', // exactly what the account holds — the tightest legitimate boundary
        paidOn: '2026-01-15',
      }),
    );

    expect(await serviceChargeBalance(f.orgId, storeC.id)).toBe(2000);
  });
});

describe('T-187 ROUND 2 — a fractional-cent amount is refused, guarding the sequential path to a negative float', () => {
  /**
   * ⛔⛔ WHAT THIS GUARDS, RECORDED SO THE REASON SURVIVES THE FIX. Measured before the fix
   * existed — ran once with no assertions, read the real output, only then wrote expectations —
   * and confirmed a defect three sessions had independently reasoned could not happen without
   * concurrency: `distributeServiceCharge` used to compare with `Number(input.amount)` but post
   * `debit: input.amount`, the raw string, into a `numeric(14,2)` column.
   *
   *     Float held exactly 10.00. Amount '10.005'.
   *     Cap (pre-fix):  Number('10.005') > Number('10.00')  →  10.005 > 10.005  →  FALSE in JS.
   *     checkDraw passed.  Postgres rounded the stored line to 10.01 on insert.
   *     Float landed at -0.01 — ONE sequential call, no concurrency — and DEF-406 (findings.test.ts)
   *     kept the ageing detector silent about it. §7's "pay only what is available; it is never
   *     negative" failed on its own terms.
   *
   * ⭐ THE FIX: the builder now routes `input.amount` through `parseMoneyInput` once, and the
   * PARSED value is what both the comparison and the posted line read — so a sub-centavo amount is
   * refused before it ever reaches the cap or `postEntry`, and the negative-float outcome above can
   * no longer occur. This describe block used to assert the pre-fix outcome directly (the -0.01);
   * per §8 the builder left this file alone and let it go red rather than adjust it, which is
   * exactly what surfaced the fix as a real behaviour change rather than an assumed one — updated
   * here to assert the refusal instead.
   */
  it('⛔ a fractional-cent amount ($10.005) is refused before any write, not silently rounded into a negative float', async () => {
    const f = await fixture('fractional-cent');
    await accrue(f, f.storeA, '2026-01-01', '10.00', uid('float'));
    const before = await ledgerCounts(f.orgId);

    let caught: Error | undefined;
    try {
      await asOrg(f.orgId, (tx) =>
        distributeServiceCharge(tx, f.admin, {
          storeId: f.storeA.id,
          moneyAccountId: f.storeA.officeCashId,
          amount: '10.005',
          paidOn: '2026-01-15',
        }),
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ name: 'RefusalError', message: 'service-charge.distribute.amount: money check failed', userMessage: 'The amount — "10.005" is not a valid amount. Use at most two decimal places.' });

    // ⛔ A guard that throws AFTER writing is the DEF-358 shape — and this one sits BEFORE the cap,
    // so nothing about invariant 1 or invariant 3 excuses skipping this check.
    const after = await ledgerCounts(f.orgId);
    expect(after).toEqual(before);
    // The float is exactly what it was — never dipped to -0.01, never rounded at all.
    expect(await serviceChargeBalance(f.orgId, f.storeA.id)).toBe(10);
  });

  /**
   * ⭐ THE POSITIVE CONTROL. `parseMoneyInput` is a new refusal on this money path — the same
   * discipline as the checkDraw boundary case above: try the tightest LEGITIMATE amount (an
   * ordinary two-decimal figure landing exactly on the cap) and confirm it is not swept up by the
   * same refusal. Without this, a guard that rejected every amount would also make the case above
   * pass, for the wrong reason.
   */
  it('a legitimate two-decimal amount, exactly at the cap, still succeeds', async () => {
    const f = await fixture('fractional-cent-control');
    await accrue(f, f.storeA, '2026-01-01', '10.00', uid('float'));

    await asOrg(f.orgId, (tx) =>
      distributeServiceCharge(tx, f.admin, {
        storeId: f.storeA.id,
        moneyAccountId: f.storeA.officeCashId,
        amount: '10.00',
        paidOn: '2026-01-15',
      }),
    );

    expect(await serviceChargeBalance(f.orgId, f.storeA.id)).toBe(0);
  });
});
