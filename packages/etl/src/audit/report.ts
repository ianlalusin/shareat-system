/**
 * The audit report — docs/tasks/114b-audit-report.md Contract §5.
 *
 * Pure rendering. It reads nothing and computes no balances: `balances.ts`, `groups.ts` and
 * `compare.ts` produce the figures, this turns them into the document Ian reads.
 *
 * Written FOR IAN, not for an engineer. He is going to type numbers out of this into a
 * spreadsheet that becomes the 1 January 2027 opening balance (ADR-005 amendment, bible row
 * 105), so every table states its own basis and every number he should NOT trust is marked as
 * such in the same table rather than in a footnote he may not reach.
 *
 * Two standing captions are non-negotiable per the task spec:
 *   - DEF-043 — AP/AR are "movement since 1 May 2026", never "the balance". Ian has since
 *     confirmed the pre-May balances were ZERO, so nothing is missing; the caption stays anyway,
 *     because a report must declare what its numbers COVER whether or not the excluded window
 *     happens to be empty.
 *   - DEF-044 — depreciation and amortization stopped after 2026-06-30 (confirmed by Ian: the
 *     scheduler is not running). Every P&L and fixed-asset figure is affected from July onward.
 *     Stated, never corrected for — correcting would invent numbers v1 does not have.
 */
import type { Money } from '@shareat/core/money';
import { add, money } from '@shareat/core/money';
import type { AccountBalance, PartyBalance, ReconstructBalancesResult } from './balances';
import type { ClassifyGroupsResult, GroupClass, GroupResult } from './groups';
import type { CrossCheckResult } from './compare';

export interface AuditReportInput {
  readonly asOf: string;
  readonly generatedAt: string;
  readonly documentsAnalysed: number;
  readonly collectionCounts: readonly { collection: string; count: number }[];
  readonly dateRange: { earliest: string | null; latest: string | null };
  readonly balances: ReconstructBalancesResult;
  readonly groups: ClassifyGroupsResult;
  readonly crossCheck: CrossCheckResult;
}

const PARTY_LABEL: Record<string, string> = {
  supplier: 'Supplier',
  customer: 'Customer',
  employee: 'Employee',
};

/** Right-aligned peso with thousands separators. Money is a decimal string, never a float. */
function peso(m: Money | null): string {
  if (m === null) return '—';
  const neg = m.startsWith('-');
  const [whole = '0', frac = '00'] = (neg ? m.slice(1) : m).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}₱${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

function sumMoney(values: readonly Money[]): Money {
  return values.reduce<Money>((acc, v) => add(acc, v), money('0'));
}

function isZero(m: Money): boolean {
  return Number(m) === 0;
}

const CLASS_LABEL: Record<GroupClass, string> = {
  balances_as_is: '✅ balances as-is',
  balances_synthesized: '✅ balances once the P&L leg is synthesised',
  ambiguous: '⚠️ ambiguous — mapping unclear',
  cannot_balance: '❌ CANNOT balance — a genuine v1 defect',
};

function section(title: string): string {
  return `\n## ${title}\n`;
}

export function renderAuditReport(input: AuditReportInput): string {
  const { balances, groups, crossCheck } = input;
  const out: string[] = [];

  out.push(`# v1 audit — as at ${input.asOf}`);
  out.push('');
  out.push(
    `> Generated ${input.generatedAt} from **${input.documentsAnalysed.toLocaleString()} landed ` +
      `documents**. Read from PostgreSQL only — this report touches production Firestore **never**.`,
  );
  out.push('>');
  out.push(
    '> **What this is for.** These are the numbers behind the 1 January 2027 opening balance. ' +
      'Where a figure should not be trusted, it says so in the same table rather than in a note ' +
      'further down.',
  );

  // ---------------------------------------------------------------------------------------
  // 1. Coverage
  // ---------------------------------------------------------------------------------------
  out.push(section('1. Coverage'));
  out.push('| Collection | Documents |');
  out.push('|---|---:|');
  for (const c of input.collectionCounts) out.push(`| \`${c.collection}\` | ${c.count.toLocaleString()} |`);
  out.push(`| **Total** | **${input.documentsAnalysed.toLocaleString()}** |`);
  out.push('');
  out.push(
    `**Business dates found:** ${input.dateRange.earliest ?? '—'} → ${input.dateRange.latest ?? '—'}.`,
  );
  out.push('');
  out.push(`**Stores included:** ${balances.includedStoreCodes.length} — journal legs summed: ` +
    `${balances.legsIncluded.toLocaleString()}` +
    (balances.legsExcludedFutureDated > 0
      ? `, plus ${balances.legsExcludedFutureDated.toLocaleString()} dated after ${input.asOf} and therefore excluded.`
      : '.'));
  if (balances.excludedStores.length > 0) {
    out.push('');
    out.push(
      '**Stores EXCLUDED from every figure below:** ' +
        balances.excludedStores.map((s) => `${s.name} (\`${s.code}\`)`).join(', ') +
        '. *(Stated because an exclusion nobody printed is how a whole store goes missing from a ' +
        'total that still looks reasonable — which happened once already on 2026-08-24.)*',
    );
  }

  // ---------------------------------------------------------------------------------------
  // 2. Cash and bank
  // ---------------------------------------------------------------------------------------
  const cashCodes = new Set(['1110', '1120', '1130', '1140', '1150']);
  const cash = balances.balances.filter((b) => cashCodes.has(b.accountCode));
  out.push(section('2. Cash and bank'));
  if (cash.length === 0) {
    out.push('*No cash or bank balances reconstructed.*');
  } else {
    out.push('| Store | Account | Balance | Legs |');
    out.push('|---|---|---:|---:|');
    for (const b of [...cash].sort((x, y) => x.storeCode.localeCompare(y.storeCode) || x.accountCode.localeCompare(y.accountCode))) {
      out.push(`| ${b.storeCode} | ${b.accountCode} | ${peso(b.netBalance)} | ${b.legCount} |`);
    }
    out.push(`| | **Total** | **${peso(sumMoney(cash.map((b) => b.netBalance)))}** | |`);
  }

  // ---------------------------------------------------------------------------------------
  // 3. AP and AR, per party
  // ---------------------------------------------------------------------------------------
  const renderParty = (code: string, heading: string, kind: 'supplier' | 'customer' | 'employee') => {
    const rows = balances.partyBalances
      .filter((p) => p.accountCode === code && !isZero(p.netBalance))
      .sort((a, b) => Math.abs(Number(b.netBalance)) - Math.abs(Number(a.netBalance)));
    out.push(section(heading));
    out.push(
      `> ⚠️ **These are movements from 1 May 2026 to ${input.asOf} — not lifetime balances.** ` +
        'v1 was never seeded with AP or AR opening figures (DEF-043): `ap_legacy_import` and ' +
        '`ar_legacy_import` do not exist in its journal at all. Ian has confirmed the pre-May ' +
        'balances were **zero**, so nothing is missing — but the caption stays, because what a ' +
        'number covers is a property of the number, not of whether the gap happened to be empty.',
    );
    out.push('');
    if (rows.length === 0) {
      out.push('*No non-zero balances.*');
      return;
    }
    out.push(`| Store | ${PARTY_LABEL[kind]} | Balance | Legs |`);
    out.push('|---|---|---:|---:|');
    for (const r of rows) out.push(`| ${r.storeCode} | \`${r.partyId}\` | ${peso(r.netBalance)} | ${r.legCount} |`);
    const total = sumMoney(rows.map((r) => r.netBalance));
    out.push(`| | **Total (${rows.length} parties)** | **${peso(total)}** | |`);
    // Invariant 3, restated for the reader: the subledger must equal its control.
    const control = balances.balances.find((b) => b.accountCode === code);
    if (control) {
      const ties = Number(control.netBalance) === Number(total);
      out.push('');
      out.push(
        `**Control-account check:** account ${code} totals ${peso(control.netBalance)}; the ` +
          `per-party rows above sum to ${peso(total)} — ` +
          (ties
            ? '**they tie exactly.** ✅'
            : '⚠️ **they DO NOT tie.** A subledger that disagrees with its control account means ' +
              'one of the two is wrong; do not use either figure until it is resolved.'),
      );
    }
  };
  renderParty('2110', '3. Accounts payable — per supplier', 'supplier');
  renderParty('1210', '4. Accounts receivable — per customer', 'customer');
  renderParty('1230', '5. Advances to employees — per employee', 'employee');

  // ---------------------------------------------------------------------------------------
  // 6. The cross-check
  // ---------------------------------------------------------------------------------------
  out.push(section("6. Cross-check — our figures vs v1's own running balances"));
  out.push(
    '> Two independent derivations of the same number: ours summed from the raw journal legs, ' +
      "v1's from the counters it maintains in `accounts/`. **Any disagreement means one of them " +
      'is wrong.* No assumption is made that ours is right — both figures are shown.',
  );
  out.push('');
  out.push(
    `Compared **${crossCheck.accountRows.length}** account/store combinations. ` +
      `**${crossCheck.disagreements.length} disagree.**`,
  );
  out.push('');
  if (crossCheck.disagreements.length === 0) {
    out.push('✅ **Every account agrees exactly.**');
  } else {
    out.push('| Store | Account | v1 says | We say | Delta | |');
    out.push('|---|---|---:|---:|---:|---|');
    for (const d of crossCheck.disagreements.slice(0, 40)) {
      const note = d.oneSided === 'v1_only' ? 'v1 only — we have no legs' : d.oneSided === 'ours_only' ? 'ours only — v1 has no account' : '';
      out.push(`| ${d.storeCode} | ${d.accountCode} | ${peso(d.v1Balance)} | ${peso(d.ourBalance)} | ${peso(d.delta)} | ${note} |`);
    }
    if (crossCheck.disagreements.length > 40) {
      out.push(`| | *…${crossCheck.disagreements.length - 40} more* | | | | |`);
    }
  }
  if (crossCheck.unmappedV1Accounts.length > 0) {
    out.push('');
    out.push(
      `**${crossCheck.unmappedV1Accounts.length} v1 account(s) have no v2 destination at all** and ` +
        'could not be cross-checked by code — reported by name instead:',
    );
    out.push('');
    out.push('| Store | v1 account id | v1 balance |');
    out.push('|---|---|---:|');
    for (const u of crossCheck.unmappedV1Accounts.slice(0, 25)) {
      out.push(`| ${u.storeCode} | \`${u.v1AccountId}\` | ${peso(u.v1Balance)} |`);
    }
  }

  // ---------------------------------------------------------------------------------------
  // 7. The group audit
  // ---------------------------------------------------------------------------------------
  out.push(section("7. Where v1's books do not balance"));
  const byClass = new Map<GroupClass, GroupResult[]>();
  for (const g of groups.groups) {
    const list = byClass.get(g.classification) ?? [];
    list.push(g);
    byClass.set(g.classification, list);
  }
  out.push('| Class | Groups | Peso magnitude |');
  out.push('|---|---:|---:|');
  const order: GroupClass[] = ['balances_as_is', 'balances_synthesized', 'ambiguous', 'cannot_balance'];
  for (const c of order) {
    const list = byClass.get(c) ?? [];
    const mag = sumMoney(list.map((g) => g.imbalance));
    out.push(`| ${CLASS_LABEL[c]} | ${list.length.toLocaleString()} | ${isZero(mag) ? '—' : peso(mag)} |`);
  }
  out.push(`| **Total** | **${groups.groups.length.toLocaleString()}** | |`);
  out.push('');
  out.push(
    '*Every group lands in exactly one class — the classes are mutually exclusive and total to ' +
      'the group count, so no group is silently unaccounted for.*',
  );

  const broken = byClass.get('cannot_balance') ?? [];
  if (broken.length > 0) {
    out.push('');
    out.push(`### ❌ The ${broken.length} that cannot balance`);
    out.push('');
    out.push(
      '**This is the finding the whole audit exists to surface.** Magnitude matters more than ' +
        'count — three groups worth ₱40 and three worth ₱400,000 are different problems.',
    );
    out.push('');
    const bySourceType = new Map<string, GroupResult[]>();
    for (const g of broken) {
      const l = bySourceType.get(g.sourceType) ?? [];
      l.push(g);
      bySourceType.set(g.sourceType, l);
    }
    out.push('| sourceType | Groups | Peso magnitude |');
    out.push('|---|---:|---:|');
    for (const [st, list] of [...bySourceType.entries()].sort(
      (a, b) => Math.abs(Number(sumMoney(b[1].map((g) => g.imbalance)))) - Math.abs(Number(sumMoney(a[1].map((g) => g.imbalance)))),
    )) {
      out.push(`| \`${st}\` | ${list.length} | ${peso(sumMoney(list.map((g) => g.imbalance)))} |`);
    }
    out.push('');
    out.push('**Largest 20 individually:**');
    out.push('');
    out.push('| Store | sourceType | sourceId | Date | Legs | Out by |');
    out.push('|---|---|---|---|---:|---:|');
    for (const g of [...broken].sort((a, b) => Math.abs(Number(b.imbalance)) - Math.abs(Number(a.imbalance))).slice(0, 20)) {
      out.push(`| ${g.storeCode} | \`${g.sourceType}\` | \`${g.sourceId}\` | ${g.businessDate ?? '—'} | ${g.legCount} | ${peso(g.imbalance)} |`);
    }
  }

  // ---------------------------------------------------------------------------------------
  // 8. Quarantine, aggregated
  // ---------------------------------------------------------------------------------------
  out.push(section('8. Quarantine — by reason'));
  const reasons = new Map<string, number>();
  for (const g of groups.groups) {
    if (g.reasonCode) reasons.set(g.reasonCode, (reasons.get(g.reasonCode) ?? 0) + 1);
  }
  if (reasons.size === 0) {
    out.push('*Nothing quarantined.*');
  } else {
    out.push('| Reason code | Groups |');
    out.push('|---|---:|');
    for (const [code, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`| \`${code}\` | ${n.toLocaleString()} |`);
    }
    out.push('');
    out.push('*Codes, not sentences — so the aggregate is the answer rather than a list to read.*');
  }

  // ---------------------------------------------------------------------------------------
  // 9. Findings from reconstruction
  // ---------------------------------------------------------------------------------------
  const allFindings = [...balances.findings, ...groups.findings];
  out.push(section('9. Data findings'));
  if (allFindings.length === 0) {
    out.push('*None.*');
  } else {
    const byType = new Map<string, number>();
    for (const f of allFindings) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
    out.push('| Finding | Count |');
    out.push('|---|---:|');
    for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`| \`${t}\` | ${n.toLocaleString()} |`);
    }
    out.push('');
    out.push('**Examples:**');
    out.push('');
    for (const f of allFindings.slice(0, 10)) out.push(`- \`${f.type}\` — ${f.storeCode} — ${f.message}`);
  }
  if (crossCheck.precisionLossFindings.length > 0) {
    out.push('');
    out.push(
      `**${crossCheck.precisionLossFindings.length} v1 balance(s) did not round-trip exactly to ` +
        'centavos** — v1 stores money as JS floats. Surfaced rather than silently rounded.',
    );
  }

  // ---------------------------------------------------------------------------------------
  // 10. FOR IAN
  // ---------------------------------------------------------------------------------------
  out.push(section('10. FOR IAN — what to trust, and what to do'));
  out.push('');
  out.push('**Known to be wrong, independent of anything above:**');
  out.push('');
  out.push(
    '- **Depreciation and amortization stopped after 2026-06-30** (DEF-044, confirmed — the ' +
      'scheduler is not running). July onward is unbooked, so **net income is overstated and net ' +
      'fixed assets are overstated**, and it compounds every month it stays off. Booking it is the ' +
      'single highest-value fix before the December close, because these figures feed the 2026 ' +
      'close and therefore the opening balance.',
  );
  out.push(
    '- **AP and AR above cover 1 May 2026 onward only** (DEF-043). Confirmed zero before that, so ' +
      'nothing is missing — but that is a fact about your history, not about the query.',
  );
  if ((byClass.get('cannot_balance') ?? []).length > 0) {
    const mag = sumMoney((byClass.get('cannot_balance') ?? []).map((g) => g.imbalance));
    out.push(
      `- **${(byClass.get('cannot_balance') ?? []).length} transaction group(s) cannot be made to ` +
        `balance, ${peso(mag)} in total.** Each is a real defect in v1's books. Section 7 lists the ` +
        'largest individually.',
    );
  }
  if (crossCheck.disagreements.length > 0) {
    out.push(
      `- **${crossCheck.disagreements.length} account(s) where v1's own counter disagrees with the ` +
        "raw legs.** One of the two is wrong in each case. v1's counters are known to drift — the AP " +
        'tile was found wired at only 3 of 8+ write paths — so do not assume v1 is right merely ' +
        'because it is the system of record.',
    );
  }
  out.push('');
  out.push('---');
  out.push('');
  out.push(
    '*Generated by `npm run audit`. Re-runnable at zero cost against the landed snapshot — it ' +
      'never re-reads production.*',
  );

  return out.join('\n') + '\n';
}
