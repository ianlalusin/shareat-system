/**
 * T-393 R9 — what "the trial balance ties" means, computed inside the dump's own snapshot.
 *
 * Three parts: (1) per org and account, debit/credit/net from `v_trial_balance` over ALL dates; (2) per org,
 * total debits and credits (which must be equal); (3) an exact `count(*)` of every base table in `public` and
 * `drizzle`. Money travels as numeric TEXT, never as a float. An empty fingerprint is a FAILURE, never a tie.
 */
import type { Sql } from 'postgres';

export interface Fingerprint {
  trialBalance: { orgId: string; accountId: string; debit: string; credit: string; net: string }[];
  orgTotals: { orgId: string; debit: string; credit: string }[];
  rowCounts: Record<string, number>;
}

/** `sql` must be the snapshot transaction (or any connection that sees every row, i.e. bypasses RLS). */
export async function computeFingerprint(sql: Sql): Promise<Fingerprint> {
  const tb = await sql<{ org: string; account: string; d: string; c: string; n: string }[]>`
    select org_id::text as org, account_id::text as account,
           sum(debit_total)::text as d, sum(credit_total)::text as c, sum(net_balance)::text as n
    from v_trial_balance
    group by org_id, account_id
    order by org_id::text, account_id::text`;
  const totals = await sql<{ org: string; d: string; c: string }[]>`
    select org_id::text as org, sum(debit_total)::text as d, sum(credit_total)::text as c
    from v_trial_balance
    group by org_id
    order by org_id::text`;
  const tables = await sql<{ schema: string; name: string }[]>`
    select n.nspname as schema, c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'drizzle') and c.relkind in ('r', 'p') and not c.relispartition
    order by n.nspname, c.relname`;
  const rowCounts: Record<string, number> = {};
  for (const t of tables) {
    const q = `select count(*)::text as n from "${t.schema.replace(/"/g, '""')}"."${t.name.replace(/"/g, '""')}"`;
    const [row] = await sql.unsafe<{ n: string }[]>(q);
    rowCounts[`${t.schema}.${t.name}`] = Number(row?.n ?? 0);
  }
  return {
    trialBalance: tb.map((r) => ({ orgId: r.org, accountId: r.account, debit: r.d, credit: r.c, net: r.n })),
    orgTotals: totals.map((r) => ({ orgId: r.org, debit: r.d, credit: r.c })),
    rowCounts,
  };
}

/** Canonical form of a numeric string, so "12.50" and "12.5000" compare equal. Never goes through a float. */
export function normalizeDecimal(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return s.trim();
  const sign = m[1] ?? '';
  const int = (m[2] ?? '0').replace(/^0+(?=\d)/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  const body = frac ? `${int}.${frac}` : int;
  return body === '0' ? '0' : `${sign}${body}`;
}

/** Refusal for a fingerprint that must not be written as a manifest (I11). Returns the reason, or null if usable. */
export function emptyLedgerReason(fp: Fingerprint): string | null {
  if ((fp.rowCounts['public.organizations'] ?? 0) < 1) return 'the database has no organizations (an empty production ledger is a misconfiguration)';
  if ((fp.rowCounts['public.journal_lines'] ?? 0) < 1) return 'the ledger has no journal lines (an empty production ledger is a misconfiguration)';
  return null;
}

/** R9, I6. `ok` only when the two fingerprints are equal AND neither is empty AND every org balances. */
export function compareFingerprints(source: Fingerprint, restored: Fingerprint): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];

  if (source.orgTotals.length === 0) mismatches.push('source fingerprint has no orgs');
  if (restored.orgTotals.length === 0) mismatches.push('restored fingerprint has no orgs (empty is not a tie)');
  const srcLines = source.rowCounts['public.journal_lines'] ?? 0;
  const resLines = restored.rowCounts['public.journal_lines'] ?? 0;
  if (srcLines > 0 && resLines === 0) mismatches.push('restored database has zero journal lines while the manifest has some');

  for (const [label, fp] of [['source', source], ['restored', restored]] as const) {
    for (const o of fp.orgTotals) {
      if (normalizeDecimal(o.debit) !== normalizeDecimal(o.credit)) {
        mismatches.push(`${label} org ${o.orgId}: debits ${o.debit} != credits ${o.credit}`);
      }
    }
  }

  const keyOf = (r: { orgId: string; accountId: string }) => `${r.orgId}/${r.accountId}`;
  const a = new Map(source.trialBalance.map((r) => [keyOf(r), r]));
  const b = new Map(restored.trialBalance.map((r) => [keyOf(r), r]));
  for (const [k, s] of a) {
    const r = b.get(k);
    if (!r) {
      mismatches.push(`org ${s.orgId} account ${s.accountId}: missing from the restored trial balance`);
      continue;
    }
    for (const f of ['debit', 'credit', 'net'] as const) {
      if (normalizeDecimal(s[f]) !== normalizeDecimal(r[f])) {
        mismatches.push(`org ${s.orgId} account ${s.accountId}: ${f} ${s[f]} != ${r[f]}`);
      }
    }
  }
  for (const [k, r] of b) if (!a.has(k)) mismatches.push(`org ${r.orgId} account ${r.accountId}: not in the manifest`);

  const ob = new Map(restored.orgTotals.map((o) => [o.orgId, o]));
  for (const s of source.orgTotals) {
    const r = ob.get(s.orgId);
    if (!r) {
      mismatches.push(`org ${s.orgId}: missing from the restored org totals`);
      continue;
    }
    if (normalizeDecimal(s.debit) !== normalizeDecimal(r.debit) || normalizeDecimal(s.credit) !== normalizeDecimal(r.credit)) {
      mismatches.push(`org ${s.orgId}: org totals differ (${s.debit}/${s.credit} vs ${r.debit}/${r.credit})`);
    }
  }

  const tables = new Set([...Object.keys(source.rowCounts), ...Object.keys(restored.rowCounts)]);
  for (const t of [...tables].sort()) {
    const x = source.rowCounts[t];
    const y = restored.rowCounts[t];
    if (x !== y) mismatches.push(`table ${t}: row count ${String(x)} in the manifest, ${String(y)} restored`);
  }

  return { ok: mismatches.length === 0, mismatches };
}
