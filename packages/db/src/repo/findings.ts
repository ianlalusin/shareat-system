/**
 * The only place SQL is written for integrity findings. T-135.
 *
 * ⭐ **Every function here is a DETECTOR: it asks the ledger a question and returns what is
 * wrong.** Nothing here stores a finding, because a stored finding can disagree with reality —
 * which is v1's one real defect in this feature, where resolving a finding suppressed the symptom
 * while the cause stayed broken.
 *
 * ⛔ **This module never writes to the ledger**, and invariant 6 of the task spec asserts it.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { findingAcknowledgements } from '../../schema/findings';
// ⛔ The ONE definition of how long each cadence allows. A private copy here would be a second
// source of truth for a number the screen also shows — bible §6.3.
import { CADENCE_DAYS } from '../../schema/stores';
import { ZERO, add, compare, equals, formatMoney, isZero, money, negate, subtract, type Money } from '@shareat/core/money';
// ⛔ T-218 — the ONE definition of "today" for the repo layer. Never bare `current_date`.
import { MANILA_TODAY, daysBetweenDates, manilaToday } from './sql-time';
import { isPreOpeningSql } from './stores';
import { notCustodySourceType, tillFloorPosition } from './remittance';
import { periodBounds } from './fiscal-periods';
import * as posV1Repo from './pos-v1';
import { STOP_AUTO_REOPEN_MINUTES } from './pin-attempts';
import { businessDayRange, formatBusinessDateTime, parseBusinessDate } from '@shareat/core/datetime';

/**
 * ⛔ **Never interpolate the symbol by hand.** A hand-rolled peso plus `toFixed(2)` renders a
 * negative as `₱-21,450.00` — symbol first, sign
 * second — which is precisely the misreading `apps/erp/src/lib/format.ts` was created to stop
 * after five screens each grew their own broken copy. A finding is read in a hurry, by someone
 * deciding whether to act, so the sign has to be where the eye expects it: `-₱21,450.00`.
 *
 * ⭐ One formatter, `@shareat/core`'s — not a fourth copy of the `Intl` options.
 */
const peso = (n: number | Money): string =>
  typeof n === 'string' ? formatMoney(n) : formatMoney(money(n.toFixed(2)));

/**
 * T-371 — the FIFO "what is the oldest credit nothing has cleared yet" walk shared by the three ageing detectors.
 * Every figure is minted to `Money` from the (14,2) SUM text and ordered with `compare`, never as a float, so a
 * NaN-text can no longer make a comparison silently false. `null` = nothing is held (balance not positive).
 */
function oldestUnclearedCredit(
  entries: { entry_date: string; credited: string; debited: string }[],
): { balance: Money; oldestUncleared: string | null } | null {
  let balance: Money = ZERO;
  let remainingDebits: Money = ZERO;
  for (const r of entries) {
    balance = add(balance, subtract(money(r.credited), money(r.debited)));
    remainingDebits = add(remainingDebits, money(r.debited));
  }
  if (compare(balance, ZERO) <= 0) return null; // nothing held — silent
  let oldestUncleared: string | null = null;
  for (const r of entries) {
    const credited = money(r.credited);
    if (compare(credited, ZERO) <= 0) continue;
    if (compare(remainingDebits, credited) >= 0) {
      remainingDebits = subtract(remainingDebits, credited);
      continue;
    }
    oldestUncleared = r.entry_date;
    break;
  }
  return { balance, oldestUncleared };
}


export interface DetectedFinding {
  kind: string;
  /** Stable identity — kind plus whatever the kind is about. Derived, never chosen by a person. */
  key: string;
  storeId: string | null;
  severity: 'hard' | 'soft';
  detail: string;
}

/**
 * ⭐ Debits must equal credits in aggregate.
 *
 * Per entry this is already impossible — a CHECK enforces it — so this is the aggregate assertion
 * that catches the thing a per-entry rule cannot: a leg that vanished, or a partial write.
 */
export async function trialBalanceDrift(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as drift
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    where je.org_id = ${orgId} and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  const drift = Number(row?.drift ?? 0);
  if (Math.abs(drift) < 0.005) return [];
  return [{
    kind: 'trialBalanceDoesNotTie',
    key: 'trialBalanceDoesNotTie',
    storeId: null,
    severity: 'hard',
    detail: `Debits and credits differ by ${peso(drift)} across the whole ledger.`,
  }];
}

/**
 * ⭐ Σ `1250 Due from related store` must equal Σ `2150 Due to related store`.
 *
 * Bible invariant 6's reciprocal check. Two features now depend on it — inter-store transfers
 * (T-133) and cross-store loan deductions in channel settlement (T-150) — so a break here means a
 * transfer went missing rather than that somebody mistyped.
 */
export async function reciprocalDrift(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const [row] = (await tx.execute(sql`
    select
      coalesce(sum(case when a.code = '1250' then jl.debit - jl.credit end), 0)::text as due_from,
      coalesce(sum(case when a.code = '2150' then jl.credit - jl.debit end), 0)::text as due_to
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  const drift = Number(row?.due_from ?? 0) - Number(row?.due_to ?? 0);
  if (Math.abs(drift) < 0.005) return [];
  return [{
    kind: 'dueFromDueToNotReciprocal',
    key: 'dueFromDueToNotReciprocal',
    storeId: null,
    severity: 'hard',
    detail:
      `Due-from totals ${peso(Number(row!.due_from))} but due-to totals ` +
      `${peso(Number(row!.due_to))}. An inter-store movement went missing.`,
  }];
}

/**
 * ⭐ T-373 S2 / DEF-559 — every UNORDERED pair of stores whose two books disagree about what one owes the other.
 *
 * `reciprocalDrift` only sums 1250 and 2150 across the whole org, so two pairs out of step by +X and -X net to zero
 * and stay silent. This is the per-pair reading `interStorePosition` uses for one pair, run for every pair at once.
 *
 * With `amt = credit - debit` on a 1250/2150 line at store S naming store P: "S owes P, per S's books" = Σ amt at S.
 * For the pair {A, B} (A < B by id) A's reading is Σ amt at A, B's reading of the same debt is -Σ amt at B, and the
 * pair is out of step exactly when the two sums do not cancel (`having`, in SQL `numeric` — never a JS compare).
 * Non-draft entries only. A line that names no pair of different stores is `interStoreLineUnmatched`'s.
 */
export async function interStorePairOutOfStep(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with pair_lines as (
      select jl.store_id as store_id,
             p.id as party_store_id,
             (jl.credit - jl.debit) as amt
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      join stores p on p.org_id = je.org_id and p.code = jl.party_id and p.id <> jl.store_id
      where je.org_id = ${orgId} and je.status <> 'draft'
        and a.code in ('1250', '2150') and jl.party_type = 'store' and jl.store_id is not null
    ),
    pairs as (
      select least(store_id::text, party_store_id::text)    as a_id,
             greatest(store_id::text, party_store_id::text) as b_id,
             sum(case when store_id::text < party_store_id::text then amt else 0 end) as sum_a,
             sum(case when store_id::text > party_store_id::text then amt else 0 end) as sum_b
      from pair_lines
      group by 1, 2
      having sum(amt) <> 0
    )
    select pr.a_id, pr.b_id,
           sa.name as a_name, sb.name as b_name,
           (sa.code < sb.code or (sa.code = sb.code and pr.a_id < pr.b_id)) as a_first,
           pr.sum_a::numeric(14,2)::text      as a_per_a,
           (-pr.sum_b)::numeric(14,2)::text   as a_per_b,
           pr.sum_b::numeric(14,2)::text      as b_per_b,
           (-pr.sum_a)::numeric(14,2)::text   as b_per_a
    from pairs pr
    join stores sa on sa.id::text = pr.a_id
    join stores sb on sb.id::text = pr.b_id
    order by pr.a_id, pr.b_id
  `)) as unknown as {
    a_id: string; b_id: string; a_name: string; b_name: string; a_first: boolean;
    a_per_a: string; a_per_b: string; b_per_b: string; b_per_a: string;
  }[];

  return rows.map((r) => {
    // Name the two stores in a fixed order (by store code) so the sentence never flips with the ids.
    const aFirst = r.a_first;
    const first = aFirst ? r.a_name : r.b_name;
    const second = aFirst ? r.b_name : r.a_name;
    const perFirst = aFirst ? r.a_per_a : r.b_per_b;
    const perSecond = aFirst ? r.a_per_b : r.b_per_a;
    // Each reading is "what `first` owes `second`" (signed). Say it in words, as an absolute amount, so the sentence
    // always names who owes whom.
    const says = (reading: string): string => {
      const m = money(reading);
      if (isZero(m)) return 'nothing is owed';
      // `reading` is always what `first` owes `second`; a negative one is the reverse debt.
      return compare(m, ZERO) > 0
        ? `${first} owes ${second} ${peso(m)}`
        : `${second} owes ${first} ${peso(negate(m))}`;
    };
    return {
      kind: 'interStorePairOutOfStep',
      key: `interStorePairOutOfStep:${r.a_id}:${r.b_id}`,
      storeId: null,
      severity: 'hard' as const,
      detail:
        `${first}'s books say ${says(perFirst)}, but ${second}'s books say ${says(perSecond)}. ` +
        'An inter-store posting is missing on one side.',
    };
  });
}

/**
 * ⭐ T-373 S2 / DEF-559 — 1250/2150 lines that no store pair can read: no store on the line, a party that is not a
 * store, a party code that matches no store in the org, or one that names the line's own store. One finding, org-wide.
 * A NULL party is `unpartiedControlLines`' (one fact, one finding), so it is excluded here.
 *
 * ⭐ T-374 S3 / DEF-580 — reversal-chain PARITY. A reversal copies the party onto itself, and a reversal may itself be
 * reversed (A → R1 → R2 → R3 …). The live tail of a chain re-states the root's line exactly when its depth (reversal
 * hops from the root) is even: A alone (0) counts, R1 (1) cancels A, R2 (2) re-states A, R3 (3) cancels again. Entries
 * with status 'reversed' are never the live tail. `interStorePairOutOfStep` needs none of this: it sums signed
 * credit − debit, so any chain nets correctly; only this count and unsigned sum need the parity.
 */
export async function interStoreLineUnmatched(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const [row] = (await tx.execute(sql`
    with recursive cand as (
      select distinct je.id
      from journal_entries je
      join journal_lines jl on jl.entry_id = je.id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and je.status <> 'draft'
        and a.code in ('1250', '2150') and jl.party_id is not null
    ),
    -- walk UP from each candidate to its root; the row whose parent is null carries the depth
    chain(cand_id, parent_id, depth) as (
      select je.id, je.reversal_of_entry_id, 0
      from journal_entries je join cand on cand.id = je.id
      union all
      select c.cand_id, p.reversal_of_entry_id, c.depth + 1
      from chain c join journal_entries p on p.id = c.parent_id
    ),
    depths as (select cand_id, depth from chain where parent_id is null)
    select count(*)::text as n,
           coalesce(sum(jl.debit + jl.credit), 0)::numeric(14,2)::text as amount
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    join depths d on d.cand_id = je.id
    where je.org_id = ${orgId} and je.status <> 'draft'
      and a.code in ('1250', '2150') and jl.party_id is not null
      -- a reversed posting and its reversal cancel; the live tail counts only at even depth
      and je.status <> 'reversed'
      and d.depth % 2 = 0
      and not (
        jl.party_type = 'store' and jl.store_id is not null
        and exists (
          select 1 from stores p
          where p.org_id = je.org_id and p.code = jl.party_id and p.id <> jl.store_id
        )
      )
  `)) as unknown as { n: string; amount: string }[];
  const n = Number(row?.n ?? 0);
  if (!(n > 0)) return [];
  return [{
    kind: 'interStoreLineUnmatched',
    key: 'interStoreLineUnmatched',
    storeId: null,
    severity: 'hard',
    detail:
      `${n} due-from/due-to line(s) worth ${peso(money(row!.amount))} don't name two different stores, ` +
      'so no store pair can account for them.',
  }];
}

/**
 * ⭐ T-366 S5 / DEF-406 — three liability control accounts that can never carry a debit balance:
 * `2160` service charge float (per STORE — Ian's T-187 Q5: the float is never negative, so `hard`),
 * `2130` reimbursables owed to staff (per EMPLOYEE party, `soft` — Q2) and `2120` goods received,
 * not yet invoiced (per STORE, `soft`). The `< 0` test is a SQL `having` clause over `numeric`,
 * never a JS float read back and compared (DEF-272's own class of bug).
 *
 * ⛔ **A NEW finding, beside the three ageing guards above (R10) — none of them is edited.** Those
 * ask "was the accrual DISCHARGED in time"; this asks "is the balance itself impossible right now."
 * A store or employee can trip both at once, and each fires independently.
 */
export async function controlAccountNegative(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const findings: DetectedFinding[] = [];

  // ⛔ Audit round — LEFT JOIN, not INNER: journal_lines.store_id is nullable, and an INNER JOIN
  // silently DROPS a store-less 2160/2120 line from every group's sum rather than grouping it on
  // its own. A line that should never exist without a store is still a line this detector must
  // see — excluding it could leave a genuinely negative account unreported. A store-less group
  // reports with `storeId: null` so it is still named, never merged into "no finding."
  const byStore = (await tx.execute(sql`
    select a.code                                    as code,
           jl.store_id::text                          as store_id,
           st.name                                    as store_name,
           (sum(jl.credit) - sum(jl.debit))::text     as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a        on a.id = jl.account_id
    left join stores st    on st.id = jl.store_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code in ('2160', '2120')
    group by a.code, jl.store_id, st.name
    having sum(jl.credit) - sum(jl.debit) < 0
    order by a.code, jl.store_id
  `)) as unknown as { code: string; store_id: string | null; store_name: string | null; balance: string }[];

  for (const r of byStore) {
    const label = r.code === '2160' ? 'Service charge float (2160)' : 'Goods received, not yet invoiced (2120)';
    const where = r.store_id ? `at ${r.store_name}` : '(no store on the line — this should never happen)';
    findings.push({
      kind: 'controlAccountNegative',
      key: `controlAccountNegative:${r.code}:${r.store_id ?? 'none'}`,
      storeId: r.store_id,
      severity: r.code === '2160' ? ('hard' as const) : ('soft' as const),
      detail: `${label} ${where} reads ${peso(Math.abs(Number(r.balance)))} negative — a control account cannot go below zero.`,
    });
  }

  // ⛔ Audit round — LEFT JOIN persons too: a dangling party_id (the person row is gone) must be
  // NAMED by its id, not silently skipped by an INNER JOIN finding no match. `jl.party_id` is
  // untouched (`p.id::text` carries the cast, not the indexed column), so
  // `journal_lines_party_type_party_id_idx` (party_type, party_id) stays usable either way the
  // equality is written. `'employee'` is the vocabulary `journal_lines_party_type_check` defines
  // (schema/journal.ts:176) — no shared TS constant exists for it today.
  const byEmployee = (await tx.execute(sql`
    select jl.party_id::text                          as employee_id,
           p.display_name                              as employee_name,
           (sum(jl.credit) - sum(jl.debit))::text      as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a        on a.id = jl.account_id
    left join persons p    on p.id::text = jl.party_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '2130' and jl.party_type = 'employee'
    group by jl.party_id, p.display_name
    having sum(jl.credit) - sum(jl.debit) < 0
    order by jl.party_id
  `)) as unknown as { employee_id: string; employee_name: string | null; balance: string }[];

  for (const r of byEmployee) {
    const who = r.employee_name ?? `person ${r.employee_id} (no longer on file)`;
    findings.push({
      kind: 'controlAccountNegative',
      key: `controlAccountNegative:2130:${r.employee_id}`,
      storeId: null,
      severity: 'soft' as const,
      detail: `Reimbursables owed to ${who} (2130) reads ${peso(Math.abs(Number(r.balance)))} negative — a control account cannot go below zero.`,
    });
  }

  return findings;
}

/**
 * ⭐ Every control account's subledger must sum to its control balance.
 *
 * A `requires_party` account whose lines carry no party is money owed by nobody — the exact shape
 * that makes an aged report lie.
 */
export async function unpartiedControlLines(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select a.code, count(*)::text as n, coalesce(sum(abs(jl.debit - jl.credit)), 0)::text as amount
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft'
      and a.requires_party = true and jl.party_id is null
    group by a.code order by a.code
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    kind: 'subledgerDoesNotMatchControl',
    key: `subledgerDoesNotMatchControl:${r.code}`,
    storeId: null,
    severity: 'hard' as const,
    detail:
      `${r.n} line(s) on ${r.code} carry no party, worth ${peso(Number(r.amount))}. ` +
      'That balance belongs to nobody, so it can never be aged or collected.',
  }));
}

/**
 * ⭐ `3900 Opening balance equity` must net to zero once the cutover is done (ADR-005).
 * A residual is the conversion not adding up, and it halts.
 */
export async function openingBalanceResidual(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '3900'
  `)) as unknown as Record<string, string>[];
  const balance = Number(row?.balance ?? 0);
  if (Math.abs(balance) < 0.005) return [];
  return [{
    kind: 'openingBalanceEquityNonZero',
    key: 'openingBalanceEquityNonZero',
    storeId: null,
    severity: 'hard',
    detail: `3900 carries ${peso(balance)}. The opening conversion does not add up.`,
  }];
}

/**
 * ⭐ The channel clearing accounts are ZERO AT REST (T-150).
 * A balance here means a settlement is mid-flight or broken — a different alarm from `1220` ageing.
 */
export async function clearingNotAtRest(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select a.code, coalesce(sum(jl.debit - jl.credit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code in ('1221','1222')
    group by a.code having abs(coalesce(sum(jl.debit - jl.credit), 0)) >= 0.005
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    kind: 'clearingAccountNotAtRest',
    key: `clearingAccountNotAtRest:${r.code}`,
    storeId: null,
    severity: 'soft' as const,
    detail: `${r.code} holds ${peso(Number(r.balance))}. Something did not finish.`,
  }));
}

/**
 * ⭐ **DEF-044 and DEF-078, made visible.**
 *
 * v1's depreciation stopped silently for two months — ₱35,483.98 a month unbooked — and only a
 * data capture found it. v2's month-end runner exists but nothing on any host fires it yet.
 *
 * ⚠️ **Compared against OPEN BALANCES, never against last month's activity.** That is DEF-044's
 * actual lesson: a schedule that simply FINISHED and a schedule that DIED look identical if you
 * only ask "was there activity last month". Only Ian could tell those apart, so the check asks
 * whether there is anything left to post instead.
 *
 * ⭐ **T-368 S4 (DEF-434): the ledger, not the run log.** This used to stay silent whenever ANY
 * `scheduler_runs` row existed for the period, so a run that failed (`outcome` `failed`), or finished
 * `partial`, hid exactly the months nothing was posted for. The run log says a job was TRIED, not that an
 * entry exists. It is not consulted here at all: this emits the provisional finding whenever something is
 * depreciable / has a prepaid balance, and `domain/findings/index.ts`'s `periodicPostingsStillMissing` — the
 * only judge — drops it when no subject owes P without an effective entry. "Booked" therefore means
 * "an effective entry exists", whatever `scheduler_runs` says.
 */
export async function periodicPostingsMissed(
  tx: Tx,
  orgId: string,
  period: string,
): Promise<DetectedFinding[]> {
  // T-346 S3 (DEF-428), §3.5 / R5.1 — a cheap SUPERSET, used only to decide whether depreciation
  // needs checking at all: an asset still HELD (in_service_on IS NULL, or later than P) is not
  // "depreciable this month" no matter how active it is. The real DETAIL count — which asset,
  // owing exactly P, has no effective entry for it — is `domain/findings/index.ts`'s job
  // (`periodicPostingsStillMissing`), never re-derived here.
  const periodEndsOn = periodBounds(period).endsOn;
  const rows = (await tx.execute(sql`
    with work as (
      select
        (select count(*) from fixed_assets fa
          where fa.org_id = ${orgId} and fa.status = 'active'
            and fa.in_service_on is not null and fa.in_service_on <= ${periodEndsOn}) as depreciable,
        (select count(*) from prepaid_items pi
          where pi.org_id = ${orgId} and pi.status = 'active') as prepaid
    )
    select
      (select depreciable from work)::text as depreciable,
      (select prepaid from work)::text as prepaid
  `)) as unknown as Record<string, string>[];
  const r = rows[0];
  if (!r) return [];
  const out: DetectedFinding[] = [];
  if (Number(r.depreciable) > 0) {
    out.push({
      kind: 'depreciationNotBooked',
      key: `depreciationNotBooked:${period}`,
      storeId: null,
      severity: 'hard',
      // ⛔ R5.1 — provisional only. `domain/findings/index.ts`'s `periodicPostingsStillMissing`
      // OVERWRITES this with the true count from `subjectsOwingWithoutEntry` whenever the finding
      // survives its filter; this superset count exists only to decide whether to check at all.
      detail:
        `${r.depreciable} asset(s) are still depreciating and nothing ran for ${period}. ` +
        'DEF-044: this stopped for two months in v1 and only a capture found it.',
    });
  }
  if (Number(r.prepaid) > 0) {
    out.push({
      kind: 'amortisationNotBooked',
      key: `amortisationNotBooked:${period}`,
      storeId: null,
      severity: 'hard',
      // ⛔ R5.1 — provisional only, same as `depreciationNotBooked` above: the domain layer
      // overwrites this detail with the true count before it is ever shown.
      detail:
        `${r.prepaid} prepaid item(s) still have a balance and nothing ran for ${period}. ` +
        '⚠️ Measured against OPEN BALANCES, not last month’s activity — a finished schedule and a ' +
        'dead one look identical the other way round.',
    });
  }
  return out;
}

/**
 * ⭐ T-264 / DEF-284 slice 1 — the mitigation for seeding periods a year at a time instead of
 * forever: seeding without a warning just moves the outage twelve months out rather than removing
 * it. Fires when the org's coverage is due to run out soon, or has already run out entirely.
 *
 * ⚠️ **Deliberately `soft`, not `hard`, in BOTH cases.** `closeReadiness` blocks the period close on
 * any `hard` finding (this file, `listFindings`'s caller), and ADR-006 §7's close gates are a
 * ratified, closed list — "the books do not add up" conditions, not "an admin has an errand." A
 * short runway is squarely the second: the ledger is right, and something administrative is
 * coming due. It must never block closing the CURRENT period. The zero-periods case is the same
 * instrument at its extreme, not a different one — and it needs no `hard` escalation of its own,
 * because an org with no periods already has every posting refused by `postEntry` itself, which is
 * louder than any finding.
 *
 * ⚠️ `RUNWAY_WARNING_DAYS = 60` (~2 months), not the 15-day close window — this fires once a year,
 * not once a month, and the cost of missing it is total (every future posting eventually refused),
 * so the notice period is longer than a routine month-end nudge.
 */
const RUNWAY_WARNING_DAYS = 60;

export async function fiscalPeriodRunwayLow(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const [row] = (await tx.execute(sql`
    select
      (select max(ends_on) from fiscal_periods where org_id = ${orgId} and status = 'open')::text
        as latest_end,
      (select (max(ends_on) - ${MANILA_TODAY})::int from fiscal_periods
        where org_id = ${orgId} and status = 'open') as days_remaining,
      (select count(*)::int from fiscal_periods where org_id = ${orgId}) as total_periods
  `)) as unknown as { latest_end: string | null; days_remaining: number | null; total_periods: number }[];

  if (!row || row.latest_end === null) {
    // ⚠️ Filtering the coverage question to `status = 'open'` is correct — `postEntry` needs an
    // OPEN period, so open-only is the right measure of postable runway. But that means this
    // branch also fires when an org HAS periods and every one of them is closed, which is a
    // different fact with a different remedy than "no periods exist" — say which one is true
    // rather than defaulting to the more alarming, possibly false, sentence. ⛔ Never suggest
    // "reopen" as the fix: ADR-006 §7.1 never builds a reopen path. The remedy in both cases is
    // the same one this whole detector points at — create (more) periods.
    const totalPeriods = Number(row?.total_periods ?? 0);
    const detail =
      totalPeriods === 0
        ? 'This organisation has no fiscal periods at all. Every posting is refused until periods ' +
          'are created — this is more urgent than the finding severity suggests; see DEF-284.'
        : `This organisation has ${totalPeriods} fiscal period(s), but none of them are open. ` +
          'Every posting is refused until new periods are created — this is more urgent than the ' +
          'finding severity suggests; see DEF-284.';
    return [{
      kind: 'fiscalPeriodRunwayLow',
      key: 'fiscalPeriodRunwayLow',
      storeId: null,
      severity: 'soft',
      detail,
    }];
  }

  const daysRemaining = Number(row.days_remaining);
  if (daysRemaining > RUNWAY_WARNING_DAYS) return [];

  return [{
    kind: 'fiscalPeriodRunwayLow',
    key: 'fiscalPeriodRunwayLow',
    storeId: null,
    severity: 'soft',
    detail:
      `Fiscal period coverage runs out on ${row.latest_end} (${daysRemaining} day(s) from today). ` +
      'Generate the next year of periods before then.',
  }];
}

// -------------------------------------------------------------------------------------
// T-152 — cash that is sitting somewhere it should not be
// -------------------------------------------------------------------------------------

/** RA 11360: service charge is distributed at intervals not exceeding sixteen days.
 *  ⚠️ `PAY_INTERVAL_MAX_DAYS` below is the SAME number for a DIFFERENT statute (Labor Code Art.
 *  103, wages) — deliberately a second constant, not an alias of this one. See its own note. */
const SERVICE_CHARGE_MAX_DAYS = 16;

interface StorePositionRow {
  store_id: string;
  store_name: string;
  cadence: string;
  ceiling: string | null;
  /** Net cashier movement not yet settled by any posted remittance. */
  outstanding: string;
  /** Of that, the part sitting on VERIFIED days — the only part that can be remitted today. */
  remittable: string;
  /** Oldest date still carrying an unsettled positive balance. */
  oldest_date: string | null;
  age_days: string | null;
}

/**
 * The un-remitted position per store, and how old the oldest unsettled day is.
 *
 * ⭐ **This mirrors `remittance.endDayReports` deliberately and must stay in step with it** — same
 * custodian resolution, same `source_type <> 'transfer'` exclusion, same "movement less
 * allocations" arithmetic. The difference is only that this asks it of every store at once.
 *
 * ⚠️ **It is ONE figure, not two tracks.** Bible row 144 split cash from online; **row 157
 * superseded it** (Ian: *"it must be END DAY REPORT"*), and T-143 §3 records the consequence —
 * *"rows 144 and 145 turn out to be one figure."* `remittance_allocations` carries no track
 * column, so splitting here would invent a division the ledger does not hold.
 */
async function storePositions(tx: Tx, orgId: string): Promise<StorePositionRow[]> {
  return (await tx.execute(sql`
    with cashier_movement as (
      select jl.store_id,
             je.entry_date,
             coalesce(sum(jl.debit - jl.credit), 0) as movement
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a        on a.id = jl.account_id
      left join money_accounts ma
        on ma.id::text = jl.party_id and jl.party_type = 'money_account'
      left join (values ('1110','cashier'), ('1120','staff'), ('1130','office'))
        as ca(code, custodian) on ca.code = a.code
      where je.org_id = ${orgId}
        and je.status <> 'draft'
        and a.code ~ '^11[0-9]{2}$'
        and coalesce(ma.custodian, ca.custodian) = 'cashier'
        -- Custody movement, not a transaction of the day. Same exclusion as endDayReports.
        and ${notCustodySourceType}
      group by jl.store_id, je.entry_date
    ),
    settled as (
      select r.store_id, ra.business_date, coalesce(sum(ra.amount), 0) as allocated
      from remittance_allocations ra
      join remittances r on r.id = ra.remittance_id
      where r.org_id = ${orgId} and r.status = 'posted'
      group by r.store_id, ra.business_date
    ),
    per_day as (
      select m.store_id,
             m.entry_date,
             (m.movement - coalesce(s.allocated, 0)) as owed,
             (sd.status = 'verified')                as is_verified
      from cashier_movement m
      left join settled s
        on s.store_id = m.store_id and s.business_date = m.entry_date
      left join sales_days sd
        on sd.org_id = ${orgId} and sd.store_id = m.store_id
       and sd.business_date = m.entry_date and sd.status <> 'voided'
    )
    select st.id::text                                              as store_id,
           st.name                                                  as store_name,
           st.remittance_cadence                                    as cadence,
           st.unremitted_ceiling::text                              as ceiling,
           -- ⛔ POSITIVE DAYS ONLY, and this is not a detail. A day the cashier paid MORE out of
           -- than came in owes nothing -- remittanceStateOf calls it "the office is out of pocket,
           -- not the till" -- so it is not negative cash in a drawer and must not net off a day
           -- that IS. Summing raw owed reported "-P21,450.00 is un-remitted" for a store holding
           -- P9,400 from three weeks earlier: the alarm fired correctly, then printed a figure
           -- that read like a rounding artefact. This matches the screen's "Ready to remit".
           coalesce(sum(pd.owed) filter (where pd.owed > 0.005), 0)::text as outstanding,
           coalesce(sum(pd.owed) filter (where pd.is_verified and pd.owed > 0.005), 0)::text
                                                                    as remittable,
           min(pd.entry_date) filter (where pd.owed > 0.005)::text   as oldest_date,
           (${MANILA_TODAY} - min(pd.entry_date) filter (where pd.owed > 0.005))::text as age_days
    from stores st
    left join per_day pd on pd.store_id = st.id
    where st.org_id = ${orgId} and st.is_active = true
    group by st.id, st.name, st.remittance_cadence, st.unremitted_ceiling
  `)) as unknown as StorePositionRow[];
}

/**
 * ⭐ **The guard T-143 shipped without.** Bible row 129.
 *
 * T-143 gave stores the ability to pool remittance across days and its §7 rule 5 says it
 * *"does not enforce the ceiling"*. So cash could accumulate unbounded with nothing watching.
 *
 * ⚠️ **The position counts ALL un-remitted cashier movement, not only the verifiable part.** The
 * risk row 129 names is *money sitting in a drawer*, and an unverified day's cash is sitting there
 * exactly as much as a verified day's. The detail reports the remittable portion separately,
 * because that is what changes what somebody should do about it.
 *
 * ⛔ **This never blocks anything.** Row 129: *"the pile becomes visible and unignorable to the
 * person who can clear it, never a blocked till."*
 */
export async function unremittedCeilingBreached(
  tx: Tx,
  orgId: string,
): Promise<DetectedFinding[]> {
  const rows = await storePositions(tx, orgId);
  const out: DetectedFinding[] = [];
  for (const r of rows) {
    if (r.ceiling === null) continue; // a `daily` store may have none — that is lawful (T-152 §2)
    const ceiling = money(r.ceiling);
    const outstanding = money(r.outstanding);
    if (!(compare(outstanding, ceiling) > 0)) continue;
    const remittable = money(r.remittable);
    const held = subtract(outstanding, remittable);
    out.push({
      kind: 'unremittedCeilingBreached',
      key: `unremittedCeilingBreached:${r.store_id}`,
      storeId: r.store_id,
      severity: 'soft',
      detail:
        `${r.store_name} is holding ${peso(outstanding)} un-remitted against a ceiling of ` +
        `${peso(ceiling)}. ${peso(remittable)} of that can be remitted now` +
        (compare(held, ZERO) > 0
          ? `; ${peso(held)} sits on days that are not verified yet, so it cannot.`
          : '.'),
    });
  }
  return out;
}

/**
 * ⭐ The cadence half of row 129 — the clock rather than the amount.
 *
 * ⚠️ **Age is the signal, not just amount** (row 147): *"₱200 outstanding for 40 days is a worse
 * finding than ₱9,000 since yesterday."* A store within its ceiling can still be far past the day
 * it should have carried the money in.
 */
export async function remittanceOverdue(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = await storePositions(tx, orgId);
  const out: DetectedFinding[] = [];
  for (const r of rows) {
    if (r.oldest_date === null || r.age_days === null) continue;
    const age = Number(r.age_days);
    const limit = CADENCE_DAYS[r.cadence as keyof typeof CADENCE_DAYS] ?? 1;
    if (!(age > limit)) continue;
    const outstanding = money(r.outstanding);
    out.push({
      kind: 'remittanceOverdue',
      key: `remittanceOverdue:${r.store_id}`,
      storeId: r.store_id,
      severity: 'soft',
      detail:
        `${r.store_name} has cash outstanding from ${r.oldest_date}, ${age} day(s) ago, on a ` +
        `${r.cadence.replace(/_/g, ' ')} cadence that allows ${limit}. ` +
        `${peso(outstanding)} is un-remitted.`,
    });
  }
  return out;
}

/**
 * ⭐ **T-153 / T-316 S3 — a till float that is not holding its configured amount.**
 *
 * > **Ian, 2026-08-29:** *"the staff just makes sure if the configured budget is 20k, every day
 * > opening and closing it is 20k."*
 *
 * ⭐ **T-316: the float is no longer a separate pot — it lives on the cashier's drawer.** So the
 * detector never reads a raw account balance. For each float-carrying store it asks
 * `tillFloorPosition` (never re-derived here) for `floatPosition` at Manila's today, and the
 * drift is `floatPosition − floatTarget`. `floatPosition` is the cashier balance less cash that is
 * merely on loan to an open day and less what closed days still owe, so **ordinary trading cannot
 * move it** — an unremitted ₱5,000 of takings is not a finding.
 *
 * ⚠️ **Short and over are different accidents.** Short: money was paid out of the till and not put
 * back — the office tops it up, and nobody is charged. Over: the office sent more than the target,
 * or an overage was booked (7350) instead of being settled against the day it came from.
 *
 * ⛔ **What this CANNOT catch:** a cashier counting ₱19,500 some morning. That is a physical count
 * against the books — `tillCountVarianceOpen` below, T-186's chargeable one. This compares the
 * BOOKS to the target, which catches a float spent or overfunded, not one quietly short in the drawer.
 * Reading this finding as "the cashier owes this" would charge somebody for a legitimate expense,
 * which is why the message says in as many words that it is not a counted shortage.
 *
 * Suppression (T-346 R1.6/R6.1, unchanged): a store still pre-opening by BOTH measures AND with a
 * cashier balance of exactly zero says nothing; any non-zero balance still fires.
 */
export async function tillFloatOffTarget(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  // T-316 S3 — one row per float-carrying store; the figure itself comes from `tillFloorPosition`
  // (never re-derived here). The query only names the pot, the store, and the pre-opening signal.
  const rows = (await tx.execute(sql`
    select ma.id::text                                          as account_id,
           ma.store_id::text                                     as store_id,
           st.name                                               as store_name,
           -- T-346 S3 (DEF-428), §3.5 / R1.6 / R6.1 -- BOTH signals must say "not yet open": the
           -- store's own stated opening_date (isPreOpeningSql -- an explicit past opening_date
           -- means open, no matter what) AND store_first_trading_date (never re-derived from
           -- opening_date alone). Suppressing on either signal ALONE is wrong in a different direction.
           (${isPreOpeningSql(sql`st.opening_date`)}
             and store_first_trading_date(ma.store_id) is null)::text as still_pre_opening
    from money_accounts ma
    left join stores st
      on st.id = ma.store_id
    where ma.org_id = ${orgId} and ma.float_target is not null and ma.is_active
    order by ma.id
  `)) as unknown as Record<string, string>[];

  const today = await manilaToday(tx);
  const out: DetectedFinding[] = [];
  for (const r of rows) {
    const pos = await tillFloorPosition(tx, orgId, { storeId: String(r.store_id), upTo: today });
    if (pos.floatTarget === null) continue;
    const target = money(pos.floatTarget);
    const floatPosition = money(pos.floatPosition);
    const drift = subtract(floatPosition, target);
    if (isZero(drift)) continue;
    // R1.6/R6.1 — suppressed ONLY when the store is still pre-opening by BOTH measures AND the
    // cashier balance itself is exactly zero (nothing has ever touched the till yet).
    if (r.still_pre_opening === 'true' && isZero(money(pos.cashierBalance))) continue;
    const lead =
      `${r.store_name}'s till float stands at ${peso(floatPosition)} on the books ` +
      `against a target of ${peso(target)} —`;
    out.push({
      kind: 'tillFloatOffTarget',
      key: `tillFloatOffTarget:${r.account_id}`,
      storeId: String(r.store_id),
      severity: 'soft',
      detail:
        compare(drift, ZERO) < 0
          ? `${lead} ${peso(negate(drift))} short. Money was paid out of the till and not put back. ` +
            'The office tops it up. ⛔ This is NOT a counted shortage and must not be charged to a cashier.'
          : `${lead} ${peso(drift)} over. Either the office sent more than the target, or an overage was ` +
            'booked (7350) instead of being settled against the day it came from. Send the surplus ' +
            'back to the office by transfer, or correct the overage.',
    });
  }
  return out;
}

/**
 * T-346 S3 (DEF-428), §3.5 — a store recorded a sale before, or with no, stated opening date.
 * Soft: this never blocks a close (ADR-006 §7 is a closed list), it is an administrative nudge.
 *
 * ⭐ **Both arms are reachable (R5.3), even though `setStoreOpeningDate` refuses a date after the
 * store's own first trading day (Amendment R3.6/R2.1) — that refusal only blocks the FORWARD
 * route.** The NULL arm fires the ordinary way: a store trades before anyone ever sets a date at
 * all. The "later than a sale" arm needs a BACKDATED sales day — one inserted (or corrected) for a
 * date before an opening date that was already set — since R3.6 makes it impossible to set an
 * opening date that is already before a KNOWN first trading day. Kept as two arms, documented,
 * rather than deleted as one that "can never fire".
 *
 * ⭐ Reuses `store_first_trading_date` (migration 0162) via `isPreOpeningSql` (R2.3) — the same
 * "has this store traded, and is its stated opening date honest about it" question `setStoreOpeningDate`
 * itself asks, never a second definition of "has traded".
 */
export async function openingDateContradicted(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with candidates as (
      -- T-346 S3 (DEF-428), R6.2/R7.1 — a cheap pre-filter BEFORE the (heavier)
      -- store_first_trading_date call below: a store can only ever contradict its own opening
      -- date if it either has none at all, or has EITHER half of "has traded" (a sales day, or a
      -- posted sale entry line — store_first_trading_date's own two arms) recorded earlier than
      -- the date it claims. Every other store is excluded here without ever computing its precise
      -- first-trading date. ⚠️ Deliberately over-inclusive: neither EXISTS filters out a voided
      -- sales day (the sales_days arm) or checks anything beyond status/source_type (the journal
      -- arm) — a false positive here only costs one extra store_first_trading_date call, while a
      -- false negative would silently drop a real contradiction.
      select st.id as store_id, st.name as name, st.opening_date as opening_date
      from stores st
      where st.org_id = ${orgId}
        and (
          st.opening_date is null
          or exists (
            select 1 from sales_days sd
            where sd.store_id = st.id and sd.business_date < st.opening_date
          )
          or exists (
            select 1 from journal_entries je
            join journal_lines jl on jl.entry_id = je.id
            where je.source_type = 'sale' and je.status = 'posted' and jl.store_id = st.id
              and je.entry_date < st.opening_date
          )
        )
    ),
    resolved as (
      select store_id, name, opening_date, store_first_trading_date(store_id) as first_trading_date
      from candidates
    )
    select store_id::text, name, opening_date::text as opening_date, first_trading_date::text as first_trading_date
    from resolved
    where first_trading_date is not null
      and ${isPreOpeningSql(sql`opening_date`, sql`first_trading_date`)}
  `)) as unknown as Record<string, string | null>[];

  return rows.map((r) => ({
    kind: 'openingDateContradicted',
    key: `openingDateContradicted:${r.store_id}`,
    storeId: String(r.store_id),
    severity: 'soft',
    detail:
      `${r.name} recorded sales on ${r.first_trading_date} but ` +
      (r.opening_date ? `opens on ${r.opening_date}` : 'has no opening date') +
      '; set its opening date — its assets depreciate from it',
  }));
}

/**
 * T-346 S3 (DEF-428), §3.5 / Amendment R1.7, R5.6 — an active asset waiting on its store to open,
 * for long enough that it is worth a nudge. Soft: never blocks a close.
 *
 * ⭐ **The store-side condition is `opening_date IS NULL`, and ONLY that** (R5.6 — the "past
 * opening date with no sales" half of the original wording is dropped as unreachable). Migration
 * 0163's fill trigger derives `in_service_on := greatest(opening_date, acquired_on)` — never
 * NULL — for a `'store_opening'` asset the instant its store's `opening_date` becomes non-NULL,
 * and `stores_opening_date_propagate` re-fires that derivation synchronously, in the same
 * transaction, for every ACTIVE follower (R4.4). So an active `'store_opening'` asset can have
 * `in_service_on IS NULL` only while its store currently has NO opening date at all — there is no
 * reachable state where the store's `opening_date` is a past date and this asset is still held.
 */
const HELD_PAST_OPENING_THRESHOLD_DAYS = 30;

export async function assetHeldPastOpening(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select fa.id::text as asset_id, fa.name as name, fa.acquired_on::text as acquired_on,
           fa.store_id::text as store_id, st.name as store_name, ${MANILA_TODAY}::text as manila_today
    from fixed_assets fa
    join stores st on st.id = fa.store_id
    where fa.org_id = ${orgId} and fa.status = 'active' and fa.in_service_source = 'store_opening'
      and fa.in_service_on is null
  `)) as unknown as Record<string, string>[];

  const out: DetectedFinding[] = [];
  for (const r of rows) {
    const days = daysBetweenDates(String(r.acquired_on), String(r.manila_today));
    if (days <= HELD_PAST_OPENING_THRESHOLD_DAYS) continue;
    out.push({
      kind: 'assetHeldPastOpening',
      key: `assetHeldPastOpening:${r.asset_id}`,
      storeId: String(r.store_id),
      severity: 'soft',
      detail:
        `${r.name} at ${r.store_name} has been waiting ${days} days to go into service; ` +
        `${r.store_name} has no opening date`,
    });
  }
  return out;
}

/**
 * ⛔ **DEF-082 — the service-charge float used to be able to only ever grow.**
 *
 * Every sales day carrying a service charge credits `2160`. ⭐ **T-187 shipped the discharge
 * path** (`distributeServiceCharge`, `packages/domain/src/service-charge/index.ts`), so this
 * alarm no longer asks "can anything debit this at all" — it asks whether a STORE's own accrual
 * actually WAS discharged, in time. RA 11360 requires distribution to rank-and-file staff at
 * intervals not exceeding sixteen days.
 *
 * ⭐ **Why this alarm existed before the document it demanded.** Ian, 2026-08-29: *"for now no we
 * dont charge but im planning."* That is the answer that needed a guard — `2160` reads zero today,
 * so it looks healthy, and the day a store first enables a service charge in POS the accrual starts
 * with **nothing to announce it**. The only symptom would be a liability quietly growing, which
 * looks exactly like a normal balance sheet.
 *
 * ⚠️ **PER STORE, not org-wide** (T-187 §2 Q4) — a payout at one store must not silence another
 * store's overdue accrual, and must not itself be silenced by another store's payout either.
 * Mirrors `grniNotAtRest`'s shape in this same file: bucket by `journal_lines.store_id`, run an
 * independent FIFO walk per store, emit one finding per store with `storeId` set.
 *
 * ⭐ **Ageing is FIFO, not "oldest line"** — credits consumed oldest-first by the debits total —
 * so a real distribution silences this exactly the way a manual debit always did.
 */
export async function serviceChargeFloatAgeing(
  tx: Tx,
  orgId: string,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select jl.store_id::text                        as store_id,
           st.name                                  as store_name,
           je.entry_date::text                      as entry_date,
           coalesce(sum(jl.credit), 0)::text        as credited,
           coalesce(sum(jl.debit), 0)::text         as debited,
           -- ⭐ T-218. Today, from POSTGRES, in Manila — carried back so the age below is measured
           -- against the same clock the rest of this module gates on. now() references no
           -- grouped column, so it is legal beside the aggregates.
           ${MANILA_TODAY}::text                    as manila_today
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a        on a.id = jl.account_id
    join stores st         on st.id = jl.store_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '2160'
    group by jl.store_id, st.name, je.entry_date
    order by jl.store_id, je.entry_date asc
  `)) as unknown as {
    store_id: string; store_name: string; entry_date: string;
    credited: string; debited: string; manila_today: string;
  }[];

  const byStore = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byStore.get(r.store_id) ?? [];
    list.push(r);
    byStore.set(r.store_id, list);
  }

  const findings: DetectedFinding[] = [];
  for (const [storeId, entries] of byStore) {
    const fifo = oldestUnclearedCredit(entries);
    if (fifo === null) continue; // nothing held — silent
    const { balance, oldestUncleared } = fifo;
    if (oldestUncleared === null) continue;

    const ageDays = daysBetweenDates(oldestUncleared, String(entries[0]!.manila_today));
    if (ageDays <= SERVICE_CHARGE_MAX_DAYS) continue;

    findings.push({
      kind: 'serviceChargeFloatAgeing',
      key: `serviceChargeFloatAgeing:${storeId}`,
      storeId,
      /**
       * ⚠️ **`soft`, and the reasoning is worth keeping.** `hard` blocks a period close and an
       * acknowledgement does not lift it — a store that misses one payday would then have every
       * close blocked with no legitimate remedy until it caught up. A control nobody can satisfy
       * is one people route around, which is how it stops being a control at all.
       *
       * ⭐ And severity here tracks *"do the books add up"*, not *"is this serious"*. Every `hard`
       * detector above is a ledger that does not tie. This one's ledger is **correct** — the
       * liability is recorded exactly as it should be. What is overdue is the **payment**, which is
       * a business fact the books are reporting faithfully. It stays loud and unresolvable instead.
       */
      severity: 'soft' as const,
      detail:
        `${entries[0]!.store_name} has held ${peso(balance)} of service charge since ` +
        `${oldestUncleared}, ${ageDays} days — RA 11360 requires distribution at intervals of at ` +
        `most ${SERVICE_CHARGE_MAX_DAYS} days. Distribute it (DEF-082).`,
    });
  }
  return findings;
}

// -------------------------------------------------------------------------------------
// Acknowledgements — the only thing this feature stores
// -------------------------------------------------------------------------------------

export interface AcknowledgementRow {
  findingKey: string;
  /** ⚠️ Null for an ORG-wide finding. Added by T-214 so the scorecard can group by store. */
  storeId: string | null;
  acknowledgedBy: string;
  acknowledgedAt: Date;
  expiresAt: Date;
  note: string | null;
}

/**
 * The LIVE acknowledgement for each finding key, newest first.
 *
 * ⚠️ Expired ones are kept and simply stop suppressing — who accepted what, and when, is the
 * accountability record.
 */
export async function liveAcknowledgements(
  tx: Tx,
  orgId: string,
): Promise<Map<string, AcknowledgementRow>> {
  const rows = (await tx.execute(sql`
    select distinct on (finding_key)
      finding_key, store_id, acknowledged_by, acknowledged_at, expires_at, note
    from finding_acknowledgements
    where org_id = ${orgId} and expires_at > now()
    order by finding_key, acknowledged_at desc
  `)) as unknown as Record<string, string | null>[];
  return new Map(
    rows.map((r) => [
      String(r.finding_key),
      {
        findingKey: String(r.finding_key),
        storeId: r.store_id == null ? null : String(r.store_id),
        acknowledgedBy: String(r.acknowledged_by),
        acknowledgedAt: new Date(String(r.acknowledged_at)),
        expiresAt: new Date(String(r.expires_at)),
        note: r.note ?? null,
      },
    ]),
  );
}

export async function insertAcknowledgement(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string | null;
    findingKey: string;
    kind: string;
    note: string | null;
    acknowledgedBy: string;
    expiresAt: Date;
  },
): Promise<void> {
  await tx.insert(findingAcknowledgements).values(input);
}

/** Every acknowledgement ever made for a key — the accountability history. */
export async function acknowledgementHistory(
  tx: Tx,
  orgId: string,
  findingKey: string,
): Promise<AcknowledgementRow[]> {
  const rows = await tx
    .select()
    .from(findingAcknowledgements)
    .where(
      and(
        eq(findingAcknowledgements.orgId, orgId),
        eq(findingAcknowledgements.findingKey, findingKey),
      ),
    );
  return rows as unknown as AcknowledgementRow[];
}

/**
 * ⭐ **T-224 — the durable half of DEF-186.**
 *
 * T-223 gave the low-stock auto-order its first caller and made a failure visible as a clause on the
 * success message of the post that triggered it. ⚠️ **A screen message dies with the request**:
 * nobody sees it twice, nobody sees it who was not the person posting, and a *repeated* failure looks
 * exactly like a first one.
 *
 * The consequence, though, is persisted — an item at or below its threshold, at a store that can
 * order, with nothing on order for it. That survives a lost log line and the cook who posted at 11pm
 * and went home, which is the difference between a message and a control.
 *
 * ## ⛔ It mirrors `ensureAutoOrderLines`' gates rather than inventing its own
 *
 * A finding that disagrees with the thing it watches is worse than no finding, so the three gates are
 * the same three, in the same order: an **active commissary link** (a store that cannot order is
 * never nagged for not ordering), **at or below threshold** on an **active** item, and **not already
 * on the open order**.
 *
 * ⭐ **"Open" means `draft`, `confirmed` OR `dispatched`, and dispatched is the one that matters.**
 * `openOrderFor`'s own comment: *"a dispatched order is goods-in-transit not yet received, so it
 * BLOCKS."* ⛔ A detector checking only `draft` would fire on every item currently in a truck — stock
 * already ordered and physically on its way. That is the noise failure this must not ship.
 *
 * ⚠️ And the line must carry `requested_quantity is not null`, matching `itemsAlreadyOnOrder`: a
 * `commissary_added` substitution is the commissary's proposal, not the branch's ask.
 *
 * ⚠️ **`soft`, deliberately.** Nothing is wrong with the books — stock is low and nothing is on
 * order. `hard` blocks a period close, and a close should not be held for a reorder.
 */
export async function lowStockOrderNotProposed(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with linked as (
      -- Gate 1: only stores that can actually order. Mirrors lowStockRepo.commissaryFor.
      select cl.branch_store_id as store_id, cl.commissary_store_id, s.name as store_name
      from commissary_links cl
      join stores s on s.id = cl.branch_store_id
      where cl.org_id = ${orgId} and cl.status = 'active'
    ),
    on_hand as (
      select sm.store_id, sm.item_id, coalesce(sum(sm.quantity), 0) as qty
      from stock_movements sm
      where sm.org_id = ${orgId}
      group by sm.store_id, sm.item_id
    ),
    low as (
      -- Gate 2: the same predicate lowStockRepo.lowStock uses, including the <= and active items.
      select ln.store_id, ln.store_name, ln.commissary_store_id,
             t.item_id, i.name as item_name,
             (t.low_stock_threshold - coalesce(h.qty, 0)) as shortfall
      from store_item_thresholds t
      join linked ln on ln.store_id = t.store_id
      join items i on i.id = t.item_id
      left join on_hand h on h.store_id = t.store_id and h.item_id = t.item_id
      where t.org_id = ${orgId}
        and i.status = 'active'
        and coalesce(h.qty, 0) <= t.low_stock_threshold
    )
    select low.store_id::text as store_id,
           low.store_name     as store_name,
           count(*)::int      as n_items,
           round(max(low.shortfall), 3)::text as deepest,
           (array_agg(low.item_name order by low.shortfall desc))[1:3] as sample
    from low
    -- Gate 3: not already on the open order. draft | confirmed | DISPATCHED -- goods in a truck are
    -- ordered, and requested_quantity is what separates the branch's ask from a commissary proposal.
    where not exists (
      select 1
      from trade_orders o
      join trade_order_lines tl on tl.order_id = o.id
      where o.org_id = ${orgId}
        and o.requested_by_store_id = low.store_id
        and o.store_id = low.commissary_store_id
        and o.status in ('draft', 'confirmed', 'dispatched')
        and tl.item_id = low.item_id
        and tl.requested_quantity is not null
    )
    group by low.store_id, low.store_name
  `)) as unknown as {
    store_id: string; store_name: string; n_items: number; deepest: string; sample: string[];
  }[];

  return rows.map((r) => ({
    kind: 'lowStockOrderNotProposed',
    key: `lowStockOrderNotProposed:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} has ${r.n_items} item${r.n_items === 1 ? '' : 's'} at or below threshold with ` +
      `nothing on order — ${(r.sample ?? []).join(', ')}${r.n_items > (r.sample ?? []).length ? ', …' : ''}. ` +
      `The deepest is ${r.deepest} below its threshold. The auto-order proposes these lines when a ` +
      'usage record is posted, so either none has been posted since the stock fell, or the ordering ' +
      'path failed and only said so on the screen of whoever posted it.',
  }));
}

/**
 * ⭐ T-175 — items being consumed in a store that has never had a reorder threshold set.
 *
 * ⚠️ **This is the replacement for v1's forcing function.** v1 blocked a usage post until somebody
 * filled the setting in, which puts the demand on a cook at 11pm who cannot answer it and is not
 * paid to. The same information as a finding reaches a manager, who can — *nag the person who can
 * act, never block the person who cannot.*
 *
 * ⛔ `soft`. A missing threshold makes the books no less true; it makes a REPLENISHMENT blind. That
 * is worth being loud about and is not worth blocking a period close over.
 */
export async function itemsMissingThreshold(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select m.store_id::text as store_id, s.name as store_name, count(distinct m.item_id)::int as n,
           min(i.name) as example
    from stock_movements m
    join items i on i.id = m.item_id
    join stores s on s.id = m.store_id
    left join store_item_thresholds t on t.store_id = m.store_id and t.item_id = m.item_id
    where m.org_id = ${orgId} and i.status = 'active' and t.id is null
      and exists (select 1 from commissary_links cl
                  where cl.branch_store_id = m.store_id and cl.status = 'active')
    group by m.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; example: string }[];

  return rows.map((r) => ({
    kind: 'itemHasNoThreshold',
    key: `itemHasNoThreshold:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} moves ${r.n} item${r.n === 1 ? '' : 's'} with no reorder threshold ` +
      `(e.g. ${r.example}). ⚠️ They can never appear on the low-stock list, and nothing else ` +
      'will say so — the store simply runs out.',
  }));
}

/**
 * ⭐ T-170: a supplier credit (`1240`) nobody has spent is money sitting with a supplier — the
 * exact gap Ian's answer closed by making a return a spendable credit instead of a silent
 * write-off. `1240` is pooled per supplier, not tracked per return (invariant 6: a query, never a
 * stored balance), so this does not attempt FIFO ageing of individual returns against later
 * spends — it flags a supplier whose CURRENT balance is positive AND whose oldest still-open
 * `supplier_advance` return is older than the threshold, which is the practical question
 * ("has this been sitting a while with nobody drawing it down") without needing to reconstruct
 * which peso of a fungible balance came from which return.
 */
export async function supplierCreditAgeing(
  tx: Tx,
  orgId: string,
  thresholdDays = 30,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select s.id as supplier_id, s.name as supplier_name,
           coalesce(sum(jl.debit - jl.credit), 0)::text as balance,
           min(sr.returned_on)::text as oldest_return
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    join suppliers s on s.id::text = jl.party_id and jl.party_type = 'supplier'
    left join supplier_returns sr on sr.supplier_id = s.id and sr.credit_basis in ('supplier_advance', 'mixed')
      and sr.status = 'posted'
    where je.org_id = ${orgId} and a.code = '1240' and je.status <> 'draft'
    group by s.id, s.name
    having coalesce(sum(jl.debit - jl.credit), 0) > 0
       and min(sr.returned_on) < (${MANILA_TODAY} - (${thresholdDays} || ' days')::interval)
  `)) as unknown as { supplier_id: string; supplier_name: string; balance: string; oldest_return: string }[];

  return rows.map((r) => ({
    kind: 'supplierCreditAgeing',
    key: `supplierCreditAgeing:${r.supplier_id}`,
    storeId: null,
    severity: 'soft' as const,
    detail:
      `${r.supplier_name} holds a ${peso(Number(r.balance))} return credit, unspent since at ` +
      `least ${r.oldest_return}. Apply it on the next AP payment or it goes unnoticed until the ` +
      'relationship ends.',
  }));
}

/**
 * ⭐ T-179's own Done-when — the AR mirror of `supplierCreditAgeing`. An unredeemed `2140`
 * balance is a liability the customer may have forgotten and we have not.
 */
export async function customerCreditAgeing(
  tx: Tx,
  orgId: string,
  thresholdDays = 30,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select c.id as customer_id, c.name as customer_name,
           coalesce(sum(jl.credit - jl.debit), 0)::text as balance,
           min(cr.returned_on)::text as oldest_return
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    join customers c on c.id::text = jl.party_id and jl.party_type = 'customer'
    left join customer_returns cr on cr.customer_id = c.id and cr.settlement in ('store_credit', 'mixed')
      and cr.status = 'posted'
    where je.org_id = ${orgId} and a.code = '2140' and je.status <> 'draft'
    group by c.id, c.name
    having coalesce(sum(jl.credit - jl.debit), 0) > 0
       and min(cr.returned_on) < (${MANILA_TODAY} - (${thresholdDays} || ' days')::interval)
  `)) as unknown as { customer_id: string; customer_name: string; balance: string; oldest_return: string }[];

  return rows.map((r) => ({
    kind: 'customerCreditAgeing',
    key: `customerCreditAgeing:${r.customer_id}`,
    storeId: null,
    severity: 'soft' as const,
    detail:
      `${r.customer_name} holds a ${peso(Number(r.balance))} return credit, unspent since at ` +
      `least ${r.oldest_return}. Apply it on their next order or refund it before it is forgotten.`,
  }));
}

/**
 * DEF-157 — `2130 Reimbursements payable to employees` is credited on every reimbursable
 * expense (`expenses/routing.ts`) and, until `payReimbursement` (T-208), had no clearing path at
 * all. Same shape as `supplierCreditAgeing`/`customerCreditAgeing`, but with no companion table
 * to read an originating date from — so the "since" date is FIFO'd from the entries themselves,
 * the same technique `serviceChargeFloatAgeing` uses for a single control account, applied here
 * per employee.
 */
export async function reimbursablePayableAgeing(
  tx: Tx,
  orgId: string,
  thresholdDays = 30,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select jl.party_id as employee_id, coalesce(p.display_name, jl.party_id) as employee_name,
           je.entry_date::text as entry_date,
           coalesce(sum(jl.credit), 0)::text as credited,
           coalesce(sum(jl.debit), 0)::text as debited,
           -- ⭐ T-218. See serviceChargeFloatAgeing — the FIFO walk below picks the date to age
           -- from, so the age cannot be computed here, but the "today" it is measured against is
           -- still Postgres's, in Manila, read once with the data.
           ${MANILA_TODAY}::text as manila_today
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    left join persons p on p.id::text = jl.party_id
    where je.org_id = ${orgId} and je.status <> 'draft'
      and a.code = '2130' and jl.party_type = 'employee'
    group by jl.party_id, p.display_name, je.entry_date
    order by jl.party_id, je.entry_date asc
  `)) as unknown as {
    employee_id: string; employee_name: string; entry_date: string; credited: string;
    debited: string; manila_today: string;
  }[];

  const byEmployee = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byEmployee.get(r.employee_id) ?? [];
    list.push(r);
    byEmployee.set(r.employee_id, list);
  }

  const findings: DetectedFinding[] = [];
  for (const [employeeId, entries] of byEmployee) {
    const fifo = oldestUnclearedCredit(entries);
    if (fifo === null) continue; // nothing held — silent
    const { balance, oldestUncleared } = fifo;
    if (oldestUncleared === null) continue;

    const ageDays = daysBetweenDates(oldestUncleared, String(rows[0]!.manila_today));
    if (ageDays <= thresholdDays) continue;

    findings.push({
      kind: 'reimbursablePayableAgeing',
      key: `reimbursablePayableAgeing:${employeeId}`,
      storeId: null,
      severity: 'soft',
      detail:
        `${entries[0]!.employee_name} is owed ${peso(balance)} in reimbursements, unpaid since ` +
        `${oldestUncleared} (${ageDays} days). Settle it with a reimbursement payout.`,
    });
  }
  return findings;
}

/**
 * DEF-159 / bible §16.10 — "age unliquidated advances; they are a standing control risk." Unlike
 * the ageing detectors above, `cash_requests` already carries its own status and release date
 * directly — no ledger FIFO needed, the row itself says whether it is still open.
 */
export async function cashRequestFloatAgeing(
  tx: Tx,
  orgId: string,
  thresholdDays = 30,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select cr.id as request_id, coalesce(p.display_name, cr.requested_for::text) as person_name,
           cr.approved_amount::text as amount, cr.released_on::text as released_on,
           -- ⭐ T-218. The age comes from the SAME statement, and the SAME clock, as the threshold
           -- on the next line. It used to be recomputed in JS from Date.now() against a date
           -- parsed as UTC midnight, so the badge could say "31 days" about a row the gate admitted
           -- on Postgres's reckoning of 30 -- two clocks, disagreeing exactly when it mattered.
           (${MANILA_TODAY} - cr.released_on)::int as age_days
    from cash_requests cr
    left join persons p on p.id = cr.requested_for
    where cr.org_id = ${orgId} and cr.status = 'released'
      and cr.released_on < (${MANILA_TODAY} - (${thresholdDays} || ' days')::interval)
  `)) as unknown as {
    request_id: string; person_name: string; amount: string; released_on: string; age_days: number;
  }[];

  return rows.map((r) => {
    const ageDays = Number(r.age_days);
    return {
      kind: 'cashRequestFloatAgeing',
      key: `cashRequestFloatAgeing:${r.request_id}`,
      storeId: null,
      severity: 'soft' as const,
      detail:
        `${r.person_name} has held a ${peso(Number(r.amount))} float since ${r.released_on} ` +
        `(${ageDays} days) with no liquidation. Settle it before releasing anything further to them.`,
    };
  });
}

/**
 * ⭐ T-167's stuck-transfer report, as a finding rather than a screen someone has to remember to
 * open. Per store, matching `stuckTransfers`'s own default — a room-to-room transfer that has sat
 * `in_transit` for more than the threshold is either forgotten or the goods never actually moved.
 */
export async function stuckStockTransfer(
  tx: Tx,
  orgId: string,
  thresholdDays = 3,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select t.store_id::text as store_id, s.name as store_name, count(*)::int as n,
           min(t.dispatched_at)::text as oldest
    from stock_transfers t
    join stores s on s.id = t.store_id
    where t.org_id = ${orgId} and t.status = 'in_transit'
      and t.dispatched_at < now() - (${thresholdDays} || ' days')::interval
    group by t.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; oldest: string }[];

  return rows.map((r) => ({
    kind: 'stuckStockTransfer',
    key: `stuckStockTransfer:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} has ${r.n} stock transfer${r.n === 1 ? '' : 's'} dispatched but never ` +
      `received, the oldest from ${r.oldest}. Goods that are neither on the shelf nor moving.`,
  }));
}

/**
 * ⭐ T-165 invariant 1 — Phase 3's exit gate, as a finding rather than only a screen someone has
 * to remember to open (`/inventory` renders the same comparison, one store at a time; this walks
 * every store in the org). `1340` in-transit is deliberately EXCLUDED — goods on a truck are in
 * no FIFO layer, and conflating the two is DEF-098.
 */
export async function inventoryControlDoesNotMatchValuation(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with layers as (
      select store_id, coalesce(sum(remaining_quantity * unit_cost), 0) as layer_value
      from stock_layers where org_id = ${orgId} group by store_id
    ), acct as (
      select l.store_id, sum(l.debit - l.credit) as account_value
      from journal_lines l join accounts a on a.id = l.account_id
      where a.org_id = ${orgId} and a.code in ('1310','1320','1330') and l.store_id is not null
      group by l.store_id
    )
    select coalesce(layers.store_id, acct.store_id) as store_id, s.name as store_name,
           coalesce(layers.layer_value, 0)::text as layer_value,
           coalesce(acct.account_value, 0)::text as account_value
    from layers full outer join acct on layers.store_id = acct.store_id
    join stores s on s.id = coalesce(layers.store_id, acct.store_id)
    where abs(coalesce(layers.layer_value, 0) - coalesce(acct.account_value, 0)) > 0.005
  `)) as unknown as { store_id: string; store_name: string; layer_value: string; account_value: string }[];

  return rows.map((r) => ({
    kind: 'inventoryControlDoesNotMatchValuation',
    key: `inventoryControlDoesNotMatchValuation:${r.store_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name}: FIFO layers total ${peso(Number(r.layer_value))} but 1310+1320+1330 total ` +
      `${peso(Number(r.account_value))}. Inventory does not tie to the ledger.`,
  }));
}

/**
 * ⭐ T-186's question: a CLOSED shift whose closing count did not match the ledger.
 *
 * ⛔ **This is the COUNTED variance, and it is the one that DOES name a person.** Its sibling
 * `tillFloatOffTarget` compares the BOOKS' float position to a target and means the office should replenish;
 * this compares a PHYSICAL COUNT to the ledger and means cash is missing from the pocket.
 * T-153 §13.4 exists because reading one as the other charges somebody for a delivery they paid
 * for correctly — so both messages say which kind they are, in as many words.
 *
 * Soft, not hard: the trial balance ties either way. A shortage is a business problem, not a
 * ledger imbalance, and blocking a close on it would push people to fudge a count to keep
 * trading — the same reasoning T-143 records for not blocking on an open remittance variance.
 */
export async function tillCountVarianceOpen(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select l.id::text                          as line_id,
           s.store_id::text                    as store_id,
           s.business_date::text               as business_date,
           s.shift_no::text                    as shift_no,
           ma.name                             as name,
           (l.counted - l.expected)::text      as variance,
           coalesce(p.display_name, '')           as closed_by_name
    from till_count_lines l
    join till_custody_shifts s on s.id = l.shift_id
    join money_accounts ma on ma.id = l.money_account_id
    left join persons p on p.id = s.closed_by
    where s.org_id = ${orgId}
      and s.status = 'closed'
      and l.moment = 'close'
      and l.counted <> l.expected
      -- Already charged: a posted shortage is answered, and re-reporting it would have
      -- somebody chase a debt that is already on the books against a named person.
      and not exists (
        select 1 from journal_entries je
        where je.org_id = s.org_id
          and je.source_type = 'tillcountshortage'
          and je.source_id = l.id::text
          and je.status <> 'draft'
      )
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => {
    const variance = money(r.variance!);
    const who = r.closed_by_name ? ` Closed by ${r.closed_by_name}.` : '';
    // ⚠️ The magnitude is formatted, never the signed number — `peso(-500)` renders "₱-500.00",
    // which has bitten this file's siblings three times. The DIRECTION is a word, not a minus sign.
    const magnitude = peso(compare(variance, ZERO) < 0 ? negate(variance) : variance);
    return {
      kind: 'tillCountVarianceOpen',
      key: `tillCountVarianceOpen:${r.line_id}`,
      storeId: String(r.store_id),
      severity: 'soft' as const,
      detail:
        `${r.name}, ${r.business_date} shift ${r.shift_no}.${who} ` +
        (compare(variance, ZERO) < 0
          ? `⭐ ${magnitude} SHORT ON A PHYSICAL COUNT — cash that should have been in the pocket ` +
            'was not. ⚠️ This one IS chargeable to the cashier who held it, unlike a ledger ' +
            'shortfall. Charge it or write it off; it will not clear on its own.'
          : `${magnitude} OVER on a physical count. ⛔ An overage posts nothing at all — it is ` +
            'money that was never in the books, and it goes to the tip box. Record the decision ' +
            'so the count stops being reported as unanswered.'),
    };
  });
}

/**
 * ⭐ **T-199 — the alarm that notices the sweep stopped, and the cheapest reliability here.**
 *
 * ⛔ A check that asks *"did the cron run?"* needs something else scheduled to ask it. Turtles.
 * So this detects the missing **OUTCOME** instead: *"three shifts from two days ago are still
 * open"* is sitting in the data, is derived on read, and is true whether or not anything is
 * scheduled — **including when the sweep itself is dead**.
 *
 * ⚠️ It is the control that would have caught all three of this business's historical failures:
 * v1's depreciation cron that never existed, POS's holiday calendar that shipped unscheduled, and
 * POS's weather job. In every case the code was fine and nobody noticed for months.
 *
 * ⛔ **`hard` severity, and deliberately so.** An open day is unpayable and unpaid — `payableDays`
 * excludes it and `resolveStatus` refuses to promote it — so closing a period over one books a
 * month that still owes somebody wages.
 */
/**
 * ⭐ T-178 — the tell that the 15-day order-wastage backstop is not running (DEF-044's shape,
 * restated for a new module). A tracked wastage still `open` or `disputed` well past its own
 * 15-day clock is exactly what the backstop exists to close; if one is sitting here, either the
 * scheduler job (`order_wastage_backstop`) is not firing, or it fired and failed on that row.
 *
 * ⚠️ A generous default threshold (`20`, not `15`) — a wastage genuinely closed ON day 15 by a
 * scheduled run that fires once a day should not flap this finding every single time it is a few
 * hours late; this is a "the job looks dead" alarm, not a live restatement of the SLA itself.
 */
export async function orderWastageOpenPastBackstop(
  tx: Tx,
  orgId: string,
  thresholdDays = 20,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select w.store_id::text as store_id, s.name as store_name, count(*)::int as n,
           min(w.opened_at)::text as oldest, coalesce(sum(w.amount), 0)::text as amount
    from order_wastages w
    join stores s on s.id = w.store_id
    where w.org_id = ${orgId} and w.type_mode = 'tracked'
      and w.status in ('open', 'disputed')
      and w.opened_at < now() - (${thresholdDays} || ' days')::interval
    group by w.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; oldest: string; amount: string }[];

  return rows.map((r) => ({
    kind: 'orderWastageOpenPastBackstop',
    key: `orderWastageOpenPastBackstop:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} has ${r.n} order wastage${r.n === 1 ? '' : 's'} worth ${peso(Number(r.amount))} still ` +
      `open past the 15-day backstop, the oldest opened ${r.oldest}. ⚠️ If this keeps appearing, ` +
      'the `order_wastage_backstop` scheduler job is not running: check that its timer is installed on the host.',
  }));
}

/**
 * ⭐ **T-220 / DEF-184 — goods signed for that never reached a stock balance, and nobody was told.**
 *
 * `confirmReceipt` correctly refuses to add a branch item denominated in `g` from a commissary
 * dispatch in `kg`: it skips the line entirely — no movement, no layer. ⛔ **Skipping is right and
 * must not be "fixed":** adding commissary-denominated quantity onto a branch balance the branch
 * reads in its own unit is the corruption the check exists to prevent, and debiting `1310` for goods
 * the stock ledger never received puts account and subledger permanently out of tie (T-173).
 *
 * ⚠️ **The defect was the silence, not the skip.** The line pushed an explanation onto
 * `unitMismatches`, which `confirmReceipt` returns and **every production caller discarded**.
 *
 * ## ⛔ DEF-188 — this shipped WRONG once, and the corrections are the interesting part
 *
 * The first version asked *"has this LINE got a `stock_movements` row?"* and reported two Lipa lines
 * as never received. **Both had their stock.** `confirmReceipt` writes
 * `source_id = orderLineIdByLineId[lineId] ?? orderId`, and DEF-140's comment claims "every real
 * path" supplies the map — dev data carries **both shapes at once**, across seven orders. Every
 * finding it produced was false, and its tests agreed with it because they used line-keyed fixtures.
 *
 * ⚠️ The obvious repair — *also accept a movement under the order id* — has a **live** blind spot,
 * not a theoretical one: multi-line orders exist today, so one order-keyed `transfer_in` would
 * suppress the finding for every line of that order, including one that genuinely never arrived.
 * That trades a false positive for a silent miss at `hard` severity, on exactly the case this
 * detector exists for.
 *
 * ⭐ **So it compares QUANTITIES per order, not the existence of a row.** What the branch signed for
 * across an order's countable lines, against what actually moved into its ledger under *either*
 * `source_id` shape. A shortfall is real regardless of which shape the writer used, and a multi-line
 * order stays detectable.
 *
 * ⛔ **And it reports no peso figure at all, deliberately.** The first version said the amount was
 * *"sitting in 1340 Inventory in transit"* — `1340` is carried at COST and held ₱180.00 while the
 * detector reported ₱1,400.00 at the transfer rate. That is DEF-175's wrong-basis mistake committed
 * in a detector written *after* DEF-175 was filed. A quantity short and the orders it happened on
 * are what a manager acts on; a synthetic peso number here would be a third basis nobody asked for.
 *
 * ⛔ **`hard`.** Goods are physically at the branch, paid for, and absent from its stock ledger, so
 * every valuation and usage figure for that item is wrong until it is fixed.
 */
export async function commissaryUnitMismatch(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with countable as (
      select o.id                              as order_id,
             c.counterparty_store_id           as branch_id,
             s.name                            as store_name,
             o.received_at                     as received_at,
             sum(l.received_quantity)          as signed_for
      from trade_order_lines l
      join trade_orders o on o.id = l.order_id
      join customers c on c.id = o.customer_id
      join stores s on s.id = c.counterparty_store_id
      where l.org_id = ${orgId}
        and o.status = 'received'
        and c.counterparty_store_id is not null
        and l.is_ledger_only = false
        and l.received_quantity is not null
        and l.received_quantity > 0
      group by o.id, c.counterparty_store_id, s.name, o.received_at
    ),
    moved as (
      select ct.order_id,
             coalesce(sum(m.quantity), 0) as into_ledger
      from countable ct
      left join stock_movements m
        on m.source_type = 'trade_order_receipt'
       and m.quantity > 0
       and (m.source_id = ct.order_id
            or m.source_id in (select l2.id from trade_order_lines l2 where l2.order_id = ct.order_id))
      group by ct.order_id
    )
    select ct.branch_id::text                          as store_id,
           ct.store_name                               as store_name,
           count(*)::int                               as n_orders,
           round(sum(ct.signed_for - mv.into_ledger), 3)::text as short_qty,
           min(ct.received_at)::text                   as oldest
    from countable ct
    join moved mv on mv.order_id = ct.order_id
    -- 0.001 matches the base-unit scale used everywhere else; a rounding whisker is not a finding.
    where (ct.signed_for - mv.into_ledger) > 0.001
    group by ct.branch_id, ct.store_name
  `)) as unknown as {
    store_id: string; store_name: string; n_orders: number; short_qty: string; oldest: string;
  }[];

  return rows.map((r) => ({
    kind: 'commissaryUnitMismatch',
    key: `commissaryUnitMismatch:${r.store_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name} signed for goods on ${r.n_orders} commissary order${r.n_orders === 1 ? '' : 's'} ` +
      `that never reached its stock ledger — ${r.short_qty} in base units short, the oldest received ` +
      `${String(r.oldest).slice(0, 10)}. Almost always a base-unit mismatch between the branch item ` +
      'and the commissary item: the receipt refused to add the quantity rather than corrupt the ' +
      'balance. Fix the branch item base unit, then confirm the receipt again.',
  }));
}

/**
 * ⭐ **T-220 — T-163's deferred detector, built now that its blocker is gone (DEF-185).**
 *
 * T-163 deferred this because *"there is no receipt document yet to age"*. **T-166 shipped delivery
 * documents**, and nothing re-checked the deferral — which is the expired-deferral class this task
 * exists to close.
 *
 * A `2120` balance is stock on the shelf, costed, whose invoice never arrived: the payable is
 * provisional and the true cost is whatever the receipt guessed. `soft` — an ageing prompt, not a
 * books-do-not-tie fault.
 *
 * ⚠️ **Per STORE, and pooled — not per supplier.** `2120` is deliberately **not** a party-requiring
 * account (T-118 set `requires_party` on exactly nine control accounts and this is not one), and
 * `postReceiptValue` writes *"one credit to 2120 for the whole receipt — the per-item detail is the
 * layers, which is the subledger; splitting the credit would put detail in two places and tie
 * neither."* A first draft of this detector grouped by `party_id` and was refused outright by
 * `journal_lines_check_party_requirement`. **The database said no, and it was right.**
 *
 * ⭐ So the balance is a POOL, and the age comes from a FIFO walk over its own credits — the same
 * shape `serviceChargeFloatAgeing` uses for the same reason. `manila_today` is carried back as a
 * column so the age is measured against Postgres's clock, in Manila, read once (T-218).
 */
export async function grniNotAtRest(
  tx: Tx,
  orgId: string,
  thresholdDays = 30,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select jl.store_id::text                        as store_id,
           st.name                                  as store_name,
           je.entry_date::text                      as entry_date,
           coalesce(sum(jl.credit), 0)::text        as credited,
           coalesce(sum(jl.debit), 0)::text         as debited,
           ${MANILA_TODAY}::text                    as manila_today
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    join stores st on st.id = jl.store_id
    where je.org_id = ${orgId} and a.code = '2120' and je.status <> 'draft'
    group by jl.store_id, st.name, je.entry_date
    order by jl.store_id, je.entry_date asc
  `)) as unknown as {
    store_id: string; store_name: string; entry_date: string;
    credited: string; debited: string; manila_today: string;
  }[];

  const byStore = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byStore.get(r.store_id) ?? [];
    list.push(r);
    byStore.set(r.store_id, list);
  }

  const findings: DetectedFinding[] = [];
  for (const [storeId, entries] of byStore) {
    const fifo = oldestUnclearedCredit(entries);
    if (fifo === null) continue; // nothing held — silent
    const { balance, oldestUncleared } = fifo;
    if (oldestUncleared === null) continue;

    const ageDays = daysBetweenDates(oldestUncleared, String(entries[0]!.manila_today));
    if (ageDays <= thresholdDays) continue;

    findings.push({
      kind: 'grniNotAtRest',
      key: `grniNotAtRest:${storeId}`,
      storeId,
      severity: 'soft' as const,
      detail:
        `${entries[0]!.store_name} holds ${peso(balance)} of received-but-uninvoiced stock in 2120 ` +
        `GRNI, the oldest uncleared since ${oldestUncleared} (${ageDays} days). The goods are on the ` +
        'shelf and costed; the invoice never arrived. Chase it — until it does the payable stays ' +
        'provisional and the true cost is whatever the receipt guessed.',
    });
  }
  return findings;
}

/**
 * ⭐ **T-218 / DEF-176 — the receiving-dispute twin of `orderWastageOpenPastBackstop` above.**
 *
 * `docs/plans/phase-6-reporting-and-dashboards.md` §6 Q3 closed one of Ian’s open questions by
 * promising this detector *"(`receivingDisputeOverdue`, T-213)"*. T-213 shipped eight detectors and
 * this was not among them — a gap that stayed invisible because **both tasks read as done**.
 *
 * ⚠️ **The asymmetry it exists to expose.** v1 runs a 15-day forced-resolution backstop for order
 * and channel *wastage* disputes and has nothing equivalent for *receiving* disputes, on the strength
 * of a code comment arguing one is unnecessary because *"disputes get resolved."* Live, that
 * assumption is about 44% false: **4 of 9 open disputes already exceed 15 days.**
 *
 * ⛔ **A `deferred` row still counts, and still ages.** A deferral is *"a promise to decide by a
 * date, not an exemption"* (T-174’s schema header) — exempting it would make the detector agree
 * with the postponement instead of observing it, which is the whole failure mode v1’s stored
 * `resolved` flag has.
 *
 * ⚠️ `store_id` is the **COMMISSARY’s**, not the branch’s: the stranded value sits on its books and
 * its manager disposes of it (T-174 invariant 11).
 *
 * ⚠️ `value` is **AT COST** — the un-received share of dispatch cost, not the transfer rate
 * (DEF-175). The wording says so, because a peso figure beside a transfer-rate figure invites
 * exactly the comparison that defect is about.
 *
 * ⛔ 15 days, not 20 — unlike the wastage backstop above there is **no scheduled job** to be
 * generously late here, so there is nothing to flap against: the threshold is the SLA itself.
 */
export async function receivingDisputeOverdue(
  tx: Tx,
  orgId: string,
  thresholdDays = 15,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select d.store_id::text as store_id, s.name as store_name, count(*)::int as n,
           -- ⭐ T-372 S6b: only a SHORT row's value is stranded in 1340 (an over row's is informational), so the peso
           -- figure sums short rows only; the count and the age stay over every row (the day-open predicate).
           coalesce(sum(d.value) filter (where d.direction = 'short'), 0)::text as amount,
           (count(*) filter (where d.direction = 'short'))::int as short_n,
           (count(*) filter (where d.direction = 'over'))::int as over_n,
           max(${MANILA_TODAY} - d.created_at::date)::int as oldest_age_days,
           (count(*) filter (where d.status = 'deferred'))::int as deferred_n
    from trade_discrepancies d
    join stores s on s.id = d.store_id
    where d.org_id = ${orgId}
      -- ⭐ The SAME predicate tradeDiscrepanciesRepo.unresolved and .blocking use. That file's
      -- header states the invariant: one source, several consumers. This is a fourth consumer,
      -- never a fourth definition — a dispute that blocks a sales day and one this finding
      -- reports must not be able to differ.
      and d.status <> 'resolved'
      -- T-398 S5e: a franchise credit has its own reconcile findings and never sat in 1340.
      and d.disposition is distinct from 'franchise_credit'
      and (${MANILA_TODAY} - d.created_at::date) > ${thresholdDays}
    group by d.store_id, s.name
  `)) as unknown as {
    store_id: string; store_name: string; n: number; amount: string; short_n: number; over_n: number;
    oldest_age_days: number; deferred_n: number;
  }[];

  return rows.map((r) => ({
    kind: 'receivingDisputeOverdue',
    key: `receivingDisputeOverdue:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    // ⭐ T-372 S6b: the sentence fits the rows it is about. A shortfall is stranded in 1340 and is disposed of as audit,
    // loss, charge or late receipt (the wording below is unchanged for a shortfall-only store); an over-receipt is on
    // nobody's books and is resolved as a commissary extra dispatch, a return/recount, or audit.
    detail:
      `${r.store_name} has ${r.n} receiving dispute${r.n === 1 ? '' : 's'} unresolved past ` +
      `${thresholdDays} days` +
      (r.short_n > 0
        ? `, worth ${peso(Number(r.amount))} at cost still stranded in 1340 Inventory in transit`
        : '') +
      ` — the oldest ${r.oldest_age_days} days old` +
      (r.deferred_n > 0
        ? `, ${r.deferred_n} of them deferred (a deferral is a promise to decide, not an exemption)`
        : '') +
      (r.over_n === 0
        ? '. Dispose of each as audit, loss, charge or late receipt.'
        : r.short_n === 0
          ? '. Resolve each over-receipt as a commissary extra dispatch, a return or recount, or audit.'
          : '. Dispose of each shortfall as audit, loss, charge or late receipt, and each over-receipt as a ' +
            'commissary extra dispatch, a return or recount, or audit.'),
  }));
}

export async function openShiftsStale(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  // ⚠️ Two days, matching the sweep's own tolerance: a night shift belongs to the previous business
  // day, and an offline terminal replays punches hours after the fact.
  const rows = (await tx.execute(sql`
    select d.store_id::text as store_id,
           count(*)::int    as n,
           min(d.shift_day)::text as oldest
      from attendance_days d
     where d.org_id = ${orgId}
       and d.status = 'open'
       and d.frozen_at is null
       and d.shift_day < ((now() at time zone 'Asia/Manila')::date - 2)
     group by d.store_id
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    kind: 'openShiftsStale',
    key: `openShiftsStale:${r.store_id}`,
    storeId: String(r.store_id),
    severity: 'hard' as const,
    detail:
      `${r.n} shift(s) are still clocked in with no clock-out, the oldest from ${r.oldest}. ` +
      '⛔ An open day is never paid — payroll excludes it and a recompute will not clear it — so ' +
      'this is unpaid work sitting in the system. ⚠️ If this keeps appearing, the nightly sweep ' +
      '(`npm run attendance-sweep`) is not running: check that its timer is installed on the host.',
  }));
}

/**
 * T-177 Sec2 - the one Phase 3 failure the exit gate cannot catch. A sale that never decrements
 * stock leaves cost never reaching COGS, so the inventory-control-equals-valuation gate stays
 * green on BOTH sides being equally wrong - inventoryControlDoesNotMatchValuation above cannot
 * see this. This detector asks a different question: for a store that has opted into POS-driven
 * consumption (it has at least one active pos_item_map), did a VERIFIED sales day get a
 * FINALIZED pull?
 *
 * Bounded to the last 14 days (read-cost discipline) - an older gap is still real but is no
 * longer this detector's job to nag about forever; it becomes a standing data-quality fact for
 * the daily review to log once, not a permanent hard finding.
 */
export async function posUsagePullNotRun(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select d.store_id::text as store_id, s.name as store_name,
           count(*)::int as n, min(d.business_date)::text as oldest
      from sales_days d
      join stores s on s.id = d.store_id
     where d.org_id = ${orgId}
       and d.status = 'verified'
       and d.business_date >= ((now() at time zone 'Asia/Manila')::date - 14)
       and exists (select 1 from pos_item_maps m where m.store_id = d.store_id and m.status = 'active')
       and not exists (
         select 1 from pos_usage_pulls p where p.sales_day_id = d.id and p.status = 'finalized'
       )
     group by d.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; oldest: string }[];

  return rows.map((r) => ({
    kind: 'posUsagePullNotRun',
    key: `posUsagePullNotRun:${r.store_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name} has ${r.n} verified sales day${r.n === 1 ? '' : 's'} with no finalized POS ` +
      `usage pull, the oldest from ${r.oldest}. Stock that was sold but never consumed here means ` +
      'its cost never reached COGS, so gross margin looks better than it is until the next ' +
      'physical count explains the gap as shrinkage.',
  }));
}

/**
 * Same words as the domain's `humanDate` ("Jan 10, 2027"): a repo may not import the domain (ADR-004), so this applies
 * the very formatter `humanDate` wraps (`@shareat/core/datetime`'s `formatBusinessDateTime`, `dateStyle: 'medium'`
 * over the date's own Manila midnight) - one formatter, not a copy. Money is `peso` above (`@shareat/core/money`).
 */
function humanDay(businessDate: string): string {
  return formatBusinessDateTime(businessDayRange(parseBusinessDate(businessDate)).start, { dateStyle: 'medium' });
}

/**
 * T-375 S6 (R10): a VERIFIED feed day whose latest `sales` feed is newer than its basis and differs in the money
 * projection (P, K, D, C, the methods map), not merely the hash. Fixed by a correction posted from the day's page.
 */
export async function posDayFeedDrift(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = await posV1Repo.feedDrift(tx, orgId);
  return rows.map((r) => ({
    kind: 'posDayFeedDrift',
    key: `posDayFeedDrift:${r.salesDayId}`,
    storeId: r.storeId,
    severity: 'hard' as const,
    detail: equals(money(r.paidThen), money(r.paidNow))
      ? `${r.storeName}'s POS payment methods for ${humanDay(r.businessDate)} changed after the day was posted ` +
        `(${peso(money(r.paidNow))} in total either way). Post a correction from the day's page.`
      : `${r.storeName}'s POS figures for ${humanDay(r.businessDate)} changed after the day was posted: ` +
        `${peso(money(r.paidThen))} paid then, ${peso(money(r.paidNow))} now. Post a correction from the day's page.`,
  }));
}

/**
 * T-375 S6 (R10, S5L-R): a usage pull with ANY finalized section whose pinned sold items are older than a newer
 * `sold_items` feed that differs in the items projection. Fixed by voiding the pull and pulling again, never by a correction.
 */
export async function posDaySoldItemsDrift(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = await posV1Repo.soldItemsDrift(tx, orgId);
  return rows.map((r) => ({
    kind: 'posDaySoldItemsDrift',
    key: `posDaySoldItemsDrift:${r.pullId}`,
    storeId: r.storeId,
    severity: 'hard' as const,
    detail:
      `${r.storeName}: POS's sold items for ${humanDay(r.businessDate)} changed after usage was posted. ` +
      'Void the POS usage pull and pull it again; the new pull reads the latest check.',
  }));
}

// -----------------------------------------------------------------------------------------
// T-213 — OIL wave 2, the operational detectors. docs/tasks/213-oil-wave-2-operational-detectors.md.
// -----------------------------------------------------------------------------------------

/**
 * ⭐ A business day POS already reported sales for, still sitting unposted. The ledger's own
 * silence is the finding — `posSourced`/`status`/`journalEntryId` already say everything a mirror-
 * collection status filter would have to reconstruct.
 *
 * ⚠️ `(now() at time zone 'Asia/Manila')::date`, never bare `current_date` — migration 0112's own
 * comment states the reason as a standing bible discipline: `current_date` follows the SESSION
 * timezone, and a production database running UTC would roll this threshold eight hours off
 * Manila's actual business day.
 */
export async function salesDayUnposted(tx: Tx, orgId: string, thresholdDays = 3): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select d.store_id::text as store_id, s.name as store_name,
           count(*)::int as n, min(d.business_date)::text as oldest
      from sales_days d
      join stores s on s.id = d.store_id
     where d.org_id = ${orgId}
       and d.pos_sourced = true
       and d.status in ('open', 'submitted')
       and d.business_date < (((now() at time zone 'Asia/Manila')::date) - (${thresholdDays} || ' days')::interval)
     group by d.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; oldest: string }[];

  return rows.map((r) => ({
    kind: 'salesDayUnposted',
    key: `salesDayUnposted:${r.store_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name} has ${r.n} POS-sourced sales day${r.n === 1 ? '' : 's'} still unposted, the ` +
      `oldest from ${r.oldest}. Revenue POS already reported has not reached the ledger.`,
  }));
}

/**
 * ⚠️ **Corrected from the phase-6 plan's `expenseMissingCategory`.** `expenses.category_id` is
 * `NOT NULL` (T-130) — a missing category cannot exist. What can exist is a draft stuck because
 * its category resolves to no mapped account, which invariant 7 refuses to post. That is the
 * live, derivable condition v1's materiality-gated sweep is standing in for now.
 *
 * ⚠️ `(now() at time zone 'Asia/Manila')::date`, never bare `current_date` — see `salesDayUnposted`.
 */
export async function expenseCategoryUnpostable(
  tx: Tx,
  orgId: string,
  thresholdDays = 3,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select e.id as expense_id, e.store_id::text as store_id, s.name as store_name,
           e.total_amount::text as amount, e.business_date::text as business_date,
           ec.category as category
      from expenses e
      join stores s on s.id = e.store_id
      join expense_categories ec on ec.id = e.category_id
     where e.org_id = ${orgId}
       and e.status = 'draft'
       and ec.account_code is null
       and e.business_date < (((now() at time zone 'Asia/Manila')::date) - (${thresholdDays} || ' days')::interval)
  `)) as unknown as {
    expense_id: string;
    store_id: string;
    store_name: string;
    amount: string;
    business_date: string;
    category: string;
  }[];

  return rows.map((r) => ({
    kind: 'expenseCategoryUnpostable',
    key: `expenseCategoryUnpostable:${r.expense_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name}'s ${peso(Number(r.amount))} expense from ${r.business_date} is stuck in ` +
      `draft — category "${r.category}" has no account mapped, so it cannot post until one is.`,
  }));
}

/**
 * ⚠️ **Corrected from the phase-6 plan's `orphanExpense`.** `supplier_invoice_id` is `NOT NULL` and
 * DB-enforced verified-at-insert (`expenses_require_verified_invoice`), so an expense can never
 * lack an invoice. But a previously-verified invoice CAN be voided afterwards — the void-cascade
 * design keeps the verified stamp as history rather than clearing it — so the real orphan
 * condition is a live link whose evidence was voided out from under it after the fact.
 */
export async function expenseInvoiceVoidedAfterLink(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select e.id as expense_id, e.store_id::text as store_id, s.name as store_name,
           e.total_amount::text as amount, si.invoice_no as invoice_no
      from expenses e
      join stores s on s.id = e.store_id
      join supplier_invoices si on si.id = e.supplier_invoice_id
     where e.org_id = ${orgId}
       and e.status <> 'voided'
       and si.status = 'voided'
  `)) as unknown as {
    expense_id: string;
    store_id: string;
    store_name: string;
    amount: string;
    invoice_no: string | null;
  }[];

  return rows.map((r) => ({
    kind: 'expenseInvoiceVoidedAfterLink',
    key: `expenseInvoiceVoidedAfterLink:${r.expense_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name}'s ${peso(Number(r.amount))} expense links invoice ` +
      `${r.invoice_no ?? '(no number)'}, which was later voided. The expense still stands on ` +
      'evidence that no longer exists.',
  }));
}

/**
 * ⭐ One statistical flag, no baseline table to maintain: the trailing-N-receipt median for the
 * same item, read from a LATERAL subquery rather than a window frame — an ordered-set aggregate's
 * frame support over ROWS is not guaranteed portable, and this needs to be right the first time.
 */
export async function receiptPriceSpike(
  tx: Tx,
  orgId: string,
  windowSize = 10,
  pctThreshold = 50,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select cur.line_id, cur.store_id::text as store_id, s.name as store_name,
           i.name as item_name, cur.unit_cost::text as unit_cost,
           cur.delivered_on::text as delivered_on, med.trailing_median::text as trailing_median
      from (
        select dl.id as line_id, d.store_id, d.org_id, dl.item_id, dl.unit_cost, d.delivered_on
          from delivery_lines dl
          join deliveries d on d.id = dl.delivery_id
         where d.status = 'received'
      ) cur
      join stores s on s.id = cur.store_id
      join items i on i.id = cur.item_id
      cross join lateral (
        select percentile_cont(0.5) within group (order by prior.unit_cost) as trailing_median
          from (
            select dl2.unit_cost
              from delivery_lines dl2
              join deliveries d2 on d2.id = dl2.delivery_id
             where d2.status = 'received'
               and dl2.item_id = cur.item_id
               and d2.store_id = cur.store_id
               and d2.delivered_on < cur.delivered_on
             order by d2.delivered_on desc
             limit ${windowSize}
          ) prior
      ) med
     where cur.org_id = ${orgId}
       and med.trailing_median is not null
       and cur.unit_cost > med.trailing_median * (1 + ${pctThreshold}::numeric / 100)
  `)) as unknown as {
    line_id: string;
    store_id: string;
    store_name: string;
    item_name: string;
    unit_cost: string;
    delivered_on: string;
    trailing_median: string;
  }[];

  return rows.map((r) => ({
    kind: 'receiptPriceSpike',
    key: `receiptPriceSpike:${r.line_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} received ${r.item_name} on ${r.delivered_on} at ${peso(Number(r.unit_cost))}, ` +
      `well above its trailing median of ${peso(Number(r.trailing_median))}. Worth a second look ` +
      'before this cost flows into landed cost and FIFO.',
  }));
}

/** A supplier's first-ever received delivery — a `NOT EXISTS` over prior receipts, nothing stored. */
export async function newVendorFirstPurchase(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select d.id as delivery_id, d.store_id::text as store_id, s.name as store_name,
           sup.name as supplier_name, d.delivered_on::text as delivered_on
      from deliveries d
      join stores s on s.id = d.store_id
      join suppliers sup on sup.id = d.supplier_id
     where d.org_id = ${orgId}
       and d.kind = 'supplier'
       and d.status = 'received'
       and not exists (
         select 1 from deliveries d2
          where d2.supplier_id = d.supplier_id
            and d2.status = 'received'
            and d2.delivered_on < d.delivered_on
       )
  `)) as unknown as {
    delivery_id: string;
    store_id: string;
    store_name: string;
    supplier_name: string;
    delivered_on: string;
  }[];

  return rows.map((r) => ({
    kind: 'newVendorFirstPurchase',
    key: `newVendorFirstPurchase:${r.delivery_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} received its first delivery from ${r.supplier_name} on ${r.delivered_on}. ` +
      'Not a problem — a nudge to confirm the supplier is who they say they are.',
  }));
}

/**
 * ⭐ **Extends `cashRequestFloatAgeing`, does not duplicate it.** That detector only sees the
 * `cash_requests` document; `docs/POSTING-PATTERNS.md` shows `1230` is also debited by salary
 * advances and till-shift shortages, neither of which is a `cash_requests` row. This reads the
 * account itself — every party's live balance, whatever posted it.
 *
 * ⚠️ `(now() at time zone 'Asia/Manila')::date`, never bare `current_date` — see `salesDayUnposted`.
 * ⛔ **`cashRequestFloatAgeing` itself does not follow this** (it compares against bare
 * `current_date`, as do `supplierCreditAgeing`, `customerCreditAgeing` and
 * `reimbursablePayableAgeing`) — logged as a defect, not fixed here; out of this task's scope.
 */
export async function advanceUnliquidated(tx: Tx, orgId: string, thresholdDays = 30): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select jl.party_id, coalesce(p.display_name, jl.party_id) as person_name,
           sum(jl.debit - jl.credit)::text as balance, min(je.entry_date)::text as oldest
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      left join persons p on p.id::text = jl.party_id
     where je.org_id = ${orgId}
       and je.status <> 'draft'
       and a.code = '1230'
       and jl.party_type = 'employee'
     group by jl.party_id, p.display_name
    having sum(jl.debit - jl.credit) > 0.005
       and min(je.entry_date) < (((now() at time zone 'Asia/Manila')::date) - (${thresholdDays} || ' days')::interval)
  `)) as unknown as { party_id: string; person_name: string; balance: string; oldest: string }[];

  return rows.map((r) => ({
    kind: 'advanceUnliquidated',
    key: `advanceUnliquidated:${r.party_id}`,
    storeId: null,
    severity: 'soft' as const,
    detail:
      `${r.person_name} carries a ${peso(Number(r.balance))} balance on 1230 open since ` +
      `${r.oldest}, from a salary advance, a shortage charge, or a cash request — whichever it ` +
      'was, it has not been liquidated.',
  }));
}

/**
 * ⚠️ **Corrected from the phase-6 plan's department-aware framing.** `departments` carries no
 * store roster and no store↔department linking table, so "which departments does this store
 * have" cannot be derived. This instead covers `posUsagePullNotRun`'s exact complement: a store
 * with NO active `pos_item_maps` — so that detector's own gate never looks at it — that verified a
 * sales day and recorded not one single usage entry of any kind.
 */
export async function usageRecordMissing(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select d.store_id::text as store_id, s.name as store_name,
           count(*)::int as n, min(d.business_date)::text as oldest
      from sales_days d
      join stores s on s.id = d.store_id
     where d.org_id = ${orgId}
       and d.status = 'verified'
       and not exists (select 1 from pos_item_maps m where m.store_id = d.store_id and m.status = 'active')
       and not exists (
         select 1 from stock_usage_records u
          where u.store_id = d.store_id and u.kind = 'usage' and u.used_on = d.business_date
       )
     group by d.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; oldest: string }[];

  return rows.map((r) => ({
    kind: 'usageRecordMissing',
    key: `usageRecordMissing:${r.store_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name} has ${r.n} verified sales day${r.n === 1 ? '' : 's'} with no usage recorded ` +
      `at all (no POS mapping active here either), the oldest from ${r.oldest}. Nothing here has ` +
      'told the books what was consumed.',
  }));
}

/** An open FIFO layer for a `meat_slab` item, ageing — a join now that layers exist to age. */
export async function meatSlabStale(tx: Tx, orgId: string, thresholdDays = 14): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select l.id as layer_id, l.store_id::text as store_id, s.name as store_name,
           i.name as item_name, l.remaining_quantity::text as remaining_quantity,
           l.received_at::text as received_at
      from stock_layers l
      join stores s on s.id = l.store_id
      join items i on i.id = l.item_id
     where l.org_id = ${orgId}
       and i.kind = 'meat_slab'
       and l.remaining_quantity > 0
       and l.received_at < (now() - (${thresholdDays} || ' days')::interval)
  `)) as unknown as {
    layer_id: string;
    store_id: string;
    store_name: string;
    item_name: string;
    remaining_quantity: string;
    received_at: string;
  }[];

  return rows.map((r) => ({
    kind: 'meatSlabStale',
    key: `meatSlabStale:${r.layer_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} still has ${r.remaining_quantity} of a ${r.item_name} slab received ` +
      `${r.received_at}, past the freshness window. Worth a look before it becomes wastage.`,
  }));
}

// ---------------------------------------------------------------------------------------------
// T-332 — the sixteen-day payday check (`payoutIntervalTooLong`) and DEF-249's visibility
// (`attendanceConfigMissing`). docs/tasks/332-store-payday-settings-and-the-sixteen-day-check.md,
// A1.1/A1.5/A1.6/A1.13.
// ---------------------------------------------------------------------------------------------

/**
 * Labor Code Art. 103: wages must be paid at intervals not exceeding sixteen days.
 * ⚠️ Equal to `SERVICE_CHARGE_MAX_DAYS` above TODAY, not BY LAW: RA 11360 (service charges) and
 * Art. 103 (wages) are two independent statutes that happen to both say sixteen. Two constants,
 * on purpose — aliasing one to the other would let an edit to either statute silently move both,
 * with nothing testing that it should. `SERVICE_CHARGE_MAX_DAYS` carries this same note.
 */
export const PAY_INTERVAL_MAX_DAYS = 16;

interface LiveCadenceConfig {
  storeId: string;
  storeName: string;
  payrollPeriodType: 'monthly' | 'semi_monthly' | 'weekly';
  semiMonthlyCutoffDay: number;
  payoutMode: 'lag' | 'fixed_days';
  payoutLagDays: number;
  payoutDays: number[];
}

/**
 * Every ACTIVE store's LIVE attendance-config cadence, for `payoutIntervalTooLong`.
 * ⛔ **Data only.** `derivePeriods`/`payoutDateFor` (`packages/domain/src/payroll/periods.ts`) are
 * what the ceiling actually has to be computed from (DEF-409 — a label-only check on
 * `payrollPeriodType` misses a `semi_monthly` store whose `fixed_days` payout collapses two
 * periods onto one payout day, 28+ days from the last one). A repo file may not import
 * `@shareat/domain` (ADR-004 — see `low-stock.ts`'s own comment on the same boundary), so this
 * only fetches; the caller runs the arithmetic and hands the result to `payoutIntervalFinding`
 * below, which is where the ceiling and the wording live.
 *
 * ⛔ **`s.is_active = true`, same filter `storePositions` above already uses.** Without it, a
 * deactivated `monthly` store fires this forever — an alarm about the pay cycle of a store that
 * pays nobody, clearable only by editing a closed store's cadence or re-acknowledging every 30
 * days. An alarm nobody can clear is how a findings feed stops being read.
 */
export async function liveCadenceConfigs(tx: Tx, orgId: string): Promise<LiveCadenceConfig[]> {
  const rows = await tx.execute(sql`
    select c.store_id::text as "storeId", s.name as "storeName",
           c.payroll_period_type as "payrollPeriodType",
           c.semi_monthly_cutoff_day as "semiMonthlyCutoffDay",
           c.payout_mode as "payoutMode", c.payout_lag_days as "payoutLagDays",
           c.payout_days as "payoutDays"
      from store_attendance_config c
      join stores s on s.id = c.store_id
     where c.org_id = ${orgId} and c.superseded_at is null and s.is_active = true`);
  return rows as unknown as LiveCadenceConfig[];
}

/**
 * Turns an ALREADY-COMPUTED longest gap between consecutive paydays into a `payoutIntervalTooLong`
 * Finding, or `null` when it satisfies Art. 103. ⭐ **Pure — no database.** Kept here, not in the
 * caller, so the ceiling and the operator-facing wording live in the one place every other
 * detector's do, even though the arithmetic that produces `maxGapDays` cannot (see
 * `liveCadenceConfigs` above).
 */
export function payoutIntervalFinding(input: {
  storeId: string;
  storeName: string;
  maxGapDays: number;
}): DetectedFinding | null {
  if (input.maxGapDays <= PAY_INTERVAL_MAX_DAYS) return null;
  return {
    kind: 'payoutIntervalTooLong',
    key: `payoutIntervalTooLong:${input.storeId}`,
    storeId: input.storeId,
    severity: 'soft',
    detail:
      `${input.storeName}'s configured pay cycle can run ${input.maxGapDays} days between paydays ` +
      `— over Labor Code Art. 103's ${PAY_INTERVAL_MAX_DAYS}-day ceiling on wage intervals. Review ` +
      'the cadence in /settings/attendance.',
  };
}

/**
 * `attendanceConfigMissing` — DEF-249's state made visible in the feed rather than only in SQL.
 * ⭐ **The exact complement of `payoutIntervalTooLong` above, mutually exclusive by construction**
 * (A1.5): a store with no live config has no cadence to judge, so this is a SECOND detector, not
 * a branch inside the first — copying `posUsagePullNotRun`/`usageRecordMissing`'s own shape and
 * the reason stated in that pair's comment.
 *
 * ⛔ **`s.is_active = true`, same reason as `liveCadenceConfigs` above.** A deactivated store with
 * no config would otherwise fire this forever too — same unclearable-alarm shape, same fix.
 */
export async function attendanceConfigMissing(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select s.id::text as store_id, s.name as store_name
      from stores s
      left join store_attendance_config c on c.store_id = s.id and c.superseded_at is null
     where s.org_id = ${orgId} and c.id is null and s.is_active = true
  `)) as unknown as { store_id: string; store_name: string }[];

  return rows.map((r) => ({
    kind: 'attendanceConfigMissing',
    key: `attendanceConfigMissing:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} has no live attendance/pay-cycle policy at all — nothing for Labor Code ` +
      'Art. 103 to judge, and /settings/attendance has nothing to show an admin until a policy ' +
      'exists to edit.',
  }));
}

// ---------------------------------------------------------------------------------------------
// T-395 S2 - the two PIN sign-in findings (R12) and the Staff panel's status read.
// Both SOFT, never hard: closeReadiness blocks a period close on hard findings, and a sign-in
// problem must not block the books.
// ---------------------------------------------------------------------------------------------

const FINDING_DAILY_MISSES = 20;
/** Ian: 7 Manila days = today and the 6 before. The cutoff date is today - (FINDING_LOOKBACK_DAYS - 1). */
const FINDING_LOOKBACK_DAYS = 7;

/**
 * `pinSignInFailures`, one per (store, terminal): some Manila day in the last 7 had at least 20
 * misses at that terminal, or the terminal caused at least one tier-1 pause. Bucketed by MANILA day
 * (never a UTC day), grouped by terminal (a null terminal keys as 'none').
 */
export async function pinSignInFailures(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with per_day as (
      select a.store_id, a.device_id,
             (a.occurred_at at time zone 'Asia/Manila')::date as day,
             count(*) filter (where a.kind = 'miss')::int    as misses,
             count(*) filter (where a.kind = 'lockout')::int as pauses,
             min(a.occurred_at) as first_at,
             max(a.occurred_at) as last_at
        from sign_in_attempts a
       where a.org_id = ${orgId}
         and (a.occurred_at at time zone 'Asia/Manila')::date >= ((now() at time zone 'Asia/Manila')::date - (${FINDING_LOOKBACK_DAYS}::int - 1))
         and a.kind in ('miss', 'lockout')
         and a.staff_code is null
       group by a.store_id, a.device_id, (a.occurred_at at time zone 'Asia/Manila')::date
    ), totals as (
      select store_id, device_id, sum(pauses)::int as pauses_total, max(misses)::int as worst
        from per_day group by store_id, device_id
    ), worst_day as (
      select distinct on (store_id, device_id) store_id, device_id, day::text as day, misses, pauses, first_at, last_at
        from per_day
       order by store_id, device_id, misses desc, pauses desc, day desc
    )
    select w.store_id::text as store_id, w.device_id::text as device_id, w.day, w.misses,
           w.first_at as first_at, w.last_at as last_at, w.pauses as pauses,
           s.name as store_name, p.display_name as device_name
      from worst_day w
      join totals t on t.store_id = w.store_id and t.device_id is not distinct from w.device_id
      join stores s on s.id = w.store_id
      left join persons p on p.id = w.device_id
     where t.worst >= ${FINDING_DAILY_MISSES}::int or t.pauses_total >= 1
     order by w.store_id, w.device_id
  `)) as unknown as {
    store_id: string;
    device_id: string | null;
    day: string;
    misses: number;
    first_at: Date | string;
    last_at: Date | string;
    pauses: number;
    store_name: string;
    device_name: string | null;
  }[];

  return rows.map((r) => ({
    kind: 'pinSignInFailures',
    key: `pinSignInFailures:${r.store_id}:${r.device_id ?? 'none'}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.misses} wrong PINs at ${r.device_name ?? 'a terminal with no name'} (${r.store_name}) on ${humanDay(r.day)}, ` +
      `between ${formatBusinessDateTime(new Date(r.first_at), { timeStyle: 'short' })} and ` +
      `${formatBusinessDateTime(new Date(r.last_at), { timeStyle: 'short' })}; it paused ${r.pauses} time(s). ` +
      'A wrong PIN does not say who typed it. If this was not a known mix-up, ask who was at the counter.',
  }));
}

/** `pinSignInStopped`, one per store whose PIN sign-in is stopped (a stop past auto-reopen has expired). */
export async function pinSignInStopped(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const auto = STOP_AUTO_REOPEN_MINUTES;
  const rows = (await tx.execute(sql`
    select t.store_id::text as store_id, s.name as store_name, t.stopped_at as stopped_at,
           (select count(*)::int from sign_in_attempts a
             where a.store_id = t.store_id and a.staff_code is null and a.kind = 'miss'
               and a.occurred_at > t.stopped_at - interval '24 hours'
               and a.occurred_at <= t.stopped_at) as misses
      from pin_attempt_throttle t
      join stores s on s.id = t.store_id
     where t.org_id = ${orgId}
       and t.stopped_at is not null
       and (${auto}::int is null or t.stopped_at + make_interval(mins => ${auto}::int) > now())
     order by t.store_id
  `)) as unknown as { store_id: string; store_name: string; stopped_at: Date | string; misses: number }[];

  return rows.map((r) => ({
    kind: 'pinSignInStopped',
    key: `pinSignInStopped:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `PIN sign-in at ${r.store_name} has been stopped since ${formatBusinessDateTime(new Date(r.stopped_at))} ` +
      `after ${r.misses} wrong PINs in a day. Nobody can sign in by PIN there until a manager reopens it on the Staff page.`,
  }));
}

// ---------------------------------------------------------------------------------------------
// T-214 — occurrences: the clock a DetectedFinding does not carry
// ---------------------------------------------------------------------------------------------

export interface OpenOccurrenceRow {
  readonly id: string;
  readonly storeId: string | null;
  readonly findingKey: string;
  readonly kind: string;
  readonly openedOn: string;
}

/** Every occurrence still open for an org. The daily job's working set. */
export async function openOccurrences(tx: Tx, orgId: string): Promise<OpenOccurrenceRow[]> {
  const rows = await tx.execute(sql`
    select id, store_id, finding_key, kind, opened_on::text as opened_on
    from finding_occurrences
    where org_id = ${orgId} and closed_on is null
    order by opened_on
  `);
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    storeId: r.store_id == null ? null : String(r.store_id),
    findingKey: String(r.finding_key),
    kind: String(r.kind),
    openedOn: String(r.opened_on),
  }));
}

/**
 * Record that a detector reported this key today.
 *
 * ⭐ **Idempotent by the partial unique index, not by a read-then-write.** Running the job twice in
 * a day advances `last_seen_on` to the same date and changes nothing else — which matters because a
 * systemd timer that fires twice after a clock change must not open a second occurrence.
 *
 * ⚠️ The conflict target must repeat the index's `coalesce` expression exactly, or Postgres cannot
 * match it to the index and the upsert becomes a plain insert that violates it.
 */
export async function observeFinding(
  tx: Tx,
  input: { orgId: string; storeId: string | null; findingKey: string; kind: string },
): Promise<void> {
  await tx.execute(sql`
    insert into finding_occurrences (org_id, store_id, finding_key, kind, opened_on, last_seen_on)
    values (${input.orgId}, ${input.storeId}, ${input.findingKey}, ${input.kind},
            ${MANILA_TODAY}, ${MANILA_TODAY})
    on conflict (org_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid), finding_key)
      where closed_on is null
    do update set last_seen_on = ${MANILA_TODAY}
  `);
}

/** Close one occurrence. ⛔ Only ever called for a key whose question the run actually asked. */
export async function closeOccurrence(tx: Tx, occurrenceId: string): Promise<void> {
  await tx.execute(sql`
    update finding_occurrences
    set closed_on = ${MANILA_TODAY}
    where id = ${occurrenceId} and closed_on is null
  `);
}

/** The date this record began — what the screen must disclose, because there is no backfill. */
export async function firstObservationDate(tx: Tx, orgId: string): Promise<string | null> {
  const rows = await tx.execute(sql`
    select min(opened_on)::text as d from finding_occurrences where org_id = ${orgId}
  `);
  const d = (rows as unknown as Record<string, unknown>[])[0]?.d;
  return d == null ? null : String(d);
}

export interface StoreScorecardRow {
  readonly storeId: string | null;
  readonly raised: number;
  readonly cleared: number;
  readonly stillOpen: number;
  /**
   * ⭐ Still open, and open LONGER than the grace window — so it has had a fair chance and counts
   * against the store. See `scorecardByStore` for why this is not simply `stillOpen`.
   */
  readonly openPastGrace: number;
  /** Still open but younger than the grace window: neither a win nor a loss yet. */
  readonly pending: number;
  /** Mean whole days open→closed over the cleared ones. Null when nothing cleared. */
  readonly avgDaysToClear: number | null;
}

/**
 * ⭐ The scorecard's arithmetic, in ONE statement, per store.
 *
 * ⚠️ **Grouped by `store_id` including NULL** — org-wide findings (a trial balance belongs to no
 * branch) form their own row and must never be spread across stores, or every branch inherits the
 * admin's problems.
 *
 * ⛔ `avg` over `closed_on - opened_on` is whole Manila days, computed by Postgres in the same
 * statement as the rows it summarises. Do not recompute this in TypeScript from `Date.now()` —
 * that is DEF-172's two-clock defect, and `findings-single-clock.test.ts` guards this file.
 *
 * ## ⭐ Why `open_past_grace` exists, and why the clear rate is not `cleared / raised`
 *
 * **Found by looking at the rendered page, not by a test.** On the first day of the record every
 * store showed a score of **0** — every finding had been raised that morning and none had been
 * cleared, so `cleared / raised` was `0/2`. But a finding raised today has not been *ignored*; it
 * has not had a chance yet, and a screen that says a branch "responded badly" on the strength of
 * a few hours is worse than showing nothing.
 *
 * So an occurrence still open and YOUNGER than the grace window is **pending** — neither a win nor
 * a loss — and is excluded from the denominator entirely. The clear rate answers *"of the findings
 * that have had a fair chance, how many were cleared?"* When everything is still pending the
 * denominator is zero, the rate is null, and the score is null: correct, and exactly what invariant
 * 7 asks for.
 *
 * ⚠️ The grace window is the same 14 days as the speed horizon, deliberately — one number, one
 * meaning: *"long enough that not acting on it is a choice."*
 */
export async function scorecardByStore(
  tx: Tx,
  orgId: string,
  fromIsoDate: string,
  toIsoDate: string,
  graceDays = 14,
): Promise<StoreScorecardRow[]> {
  const rows = await tx.execute(sql`
    select
      store_id,
      count(*)::int                                        as raised,
      count(*) filter (where closed_on is not null)::int    as cleared,
      count(*) filter (where closed_on is null)::int        as still_open,
      count(*) filter (
        where closed_on is null and (${MANILA_TODAY} - opened_on) > ${graceDays}
      )::int                                               as open_past_grace,
      count(*) filter (
        where closed_on is null and (${MANILA_TODAY} - opened_on) <= ${graceDays}
      )::int                                               as pending,
      avg(closed_on - opened_on) filter (where closed_on is not null) as avg_days
    from finding_occurrences
    where org_id = ${orgId}
      and opened_on >= ${fromIsoDate}::date
      and opened_on <= ${toIsoDate}::date
    group by store_id
  `);
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    storeId: r.store_id == null ? null : String(r.store_id),
    raised: Number(r.raised),
    cleared: Number(r.cleared),
    stillOpen: Number(r.still_open),
    openPastGrace: Number(r.open_past_grace),
    pending: Number(r.pending),
    avgDaysToClear: r.avg_days == null ? null : Math.round(Number(r.avg_days) * 10) / 10,
  }));
}

// ---------------------------------------------------------------------------------------------
// T-214 — the view log
// ---------------------------------------------------------------------------------------------

/** ⛔ One row per person per Manila day. A refresh is not a second view. */
export async function recordFindingView(
  tx: Tx,
  input: { orgId: string; personId: string },
): Promise<void> {
  await tx.execute(sql`
    insert into finding_views (org_id, person_id, viewed_on)
    values (${input.orgId}, ${input.personId}, ${MANILA_TODAY})
    on conflict (org_id, person_id, viewed_on) do nothing
  `);
}

export interface LastViewRow {
  readonly personId: string;
  readonly displayName: string;
  readonly viewedOn: string;
  readonly daysAgo: number;
}

/**
 * Who last opened `/findings`, and how long ago.
 *
 * ⚠️ A `null` return is the useful answer, not a missing one: **nobody has ever opened this screen.**
 */
export async function lastFindingView(tx: Tx, orgId: string): Promise<LastViewRow | null> {
  const rows = await tx.execute(sql`
    select v.person_id, p.display_name, v.viewed_on::text as viewed_on,
           (${MANILA_TODAY} - v.viewed_on)::int as days_ago
    from finding_views v
    join persons p on p.id = v.person_id
    where v.org_id = ${orgId}
    order by v.viewed_on desc
    limit 1
  `);
  const r = (rows as unknown as Record<string, unknown>[])[0];
  if (!r) return null;
  return {
    personId: String(r.person_id),
    displayName: String(r.display_name),
    viewedOn: String(r.viewed_on),
    daysAgo: Number(r.days_ago),
  };
}
