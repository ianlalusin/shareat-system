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
    detail: `Debits and credits differ by ₱${drift.toFixed(2)} across the whole ledger.`,
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
      `Due-from totals ₱${Number(row!.due_from).toFixed(2)} but due-to totals ` +
      `₱${Number(row!.due_to).toFixed(2)}. An inter-store movement went missing.`,
  }];
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
      `${r.n} line(s) on ${r.code} carry no party, worth ₱${Number(r.amount).toFixed(2)}. ` +
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
    detail: `3900 carries ₱${balance.toFixed(2)}. The opening conversion does not add up.`,
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
    detail: `${r.code} holds ₱${Number(r.balance).toFixed(2)}. Something did not finish.`,
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
 */
export async function periodicPostingsMissed(
  tx: Tx,
  orgId: string,
  period: string,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with work as (
      select
        (select count(*) from fixed_assets fa
          where fa.org_id = ${orgId} and fa.status = 'active') as depreciable,
        (select count(*) from prepaid_items pi
          where pi.org_id = ${orgId} and pi.status = 'active') as prepaid
    ),
    ran as (
      select job, count(*)::int as n
      from scheduler_runs sr
      where sr.org_id = ${orgId} and sr.period = ${period}
      group by job
    )
    select
      (select depreciable from work)::text as depreciable,
      (select prepaid from work)::text as prepaid,
      coalesce((select n from ran where job = 'depreciation'), 0)::text as depreciation_runs,
      coalesce((select n from ran where job = 'amortisation'), 0)::text as amortisation_runs
  `)) as unknown as Record<string, string>[];
  const r = rows[0];
  if (!r) return [];
  const out: DetectedFinding[] = [];
  if (Number(r.depreciable) > 0 && Number(r.depreciation_runs) === 0) {
    out.push({
      kind: 'depreciationNotBooked',
      key: `depreciationNotBooked:${period}`,
      storeId: null,
      severity: 'hard',
      detail:
        `${r.depreciable} asset(s) are still depreciating and nothing ran for ${period}. ` +
        'DEF-044: this stopped for two months in v1 and only a capture found it.',
    });
  }
  if (Number(r.prepaid) > 0 && Number(r.amortisation_runs) === 0) {
    out.push({
      kind: 'amortisationNotBooked',
      key: `amortisationNotBooked:${period}`,
      storeId: null,
      severity: 'hard',
      detail:
        `${r.prepaid} prepaid item(s) still have a balance and nothing ran for ${period}. ` +
        '⚠️ Measured against OPEN BALANCES, not last month’s activity — a finished schedule and a ' +
        'dead one look identical the other way round.',
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------
// Acknowledgements — the only thing this feature stores
// -------------------------------------------------------------------------------------

export interface AcknowledgementRow {
  findingKey: string;
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
      finding_key, acknowledged_by, acknowledged_at, expires_at, note
    from finding_acknowledgements
    where org_id = ${orgId} and expires_at > now()
    order by finding_key, acknowledged_at desc
  `)) as unknown as Record<string, string>[];
  return new Map(
    rows.map((r) => [
      String(r.finding_key),
      {
        findingKey: String(r.finding_key),
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
