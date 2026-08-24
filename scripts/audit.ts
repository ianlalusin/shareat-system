/**
 * `npm run audit` — docs/tasks/114b-audit-report.md Contract §5.
 *
 * Reads the LANDED snapshot from PostgreSQL and writes docs/reviews/v1-audit-<asOf>.md.
 * It opens no Firestore client and imports nothing from `@shareat/etl-firestore` (invariant
 * 16), so it costs nothing to re-run and cannot touch production however it is invoked.
 *
 * Read-only against `etl_source_documents` (invariant 17). Migration 0009's trigger would
 * reject a write anyway — but not attempting one is the actual guarantee.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

import { reconstructBalances, type LandedDocLike } from '../packages/etl/src/audit/balances';
import { classifyGroups } from '../packages/etl/src/audit/groups';
import { crossCheck } from '../packages/etl/src/audit/compare';
import { renderAuditReport } from '../packages/etl/src/audit/report';

const SOURCE_SYSTEM = 'erp_v1';

function parseArgs(argv: readonly string[]): { asOf: string } {
  let asOf: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as-of') asOf = argv[++i] ?? null;
  }
  if (asOf === null) {
    // Default to today rather than erroring: unlike `capture`, this reads nothing external,
    // so a default cannot cost anything or touch anything.
    asOf = new Date().toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error(`--as-of must be YYYY-MM-DD, got "${asOf}"`);
  }
  return { asOf };
}

async function main(): Promise<void> {
  const { asOf } = parseArgs(process.argv.slice(2));

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. See .env.example.');
  const sql = postgres(url, { max: 2 });

  try {
    // "Current" = greatest captured_at per doc_path — a derivation, never a maintained flag
    // (bible §4.2 rule 7), matching repo/etl.ts's findCurrentDocuments.
    const rows = await sql<
      { doc_path: string; collection_path: string; store_code: string | null; payload: Record<string, unknown> }[]
    >`
      select distinct on (doc_path) doc_path, collection_path, store_code, payload
      from etl_source_documents
      where source_system = ${SOURCE_SYSTEM}
      order by doc_path, captured_at desc
    `;

    const docs: LandedDocLike[] = rows.map((r) => ({
      docPath: r.doc_path,
      collectionPath: r.collection_path,
      storeCode: r.store_code,
      payload: r.payload,
    }));

    console.log(`Loaded ${docs.length.toLocaleString()} current landed documents.`);

    const collectionCounts = [...docs.reduce((m, d) => {
      const name = d.collectionPath.split('/').pop() ?? d.collectionPath;
      return m.set(name, (m.get(name) ?? 0) + 1);
    }, new Map<string, number>())]
      .map(([collection, count]) => ({ collection, count }))
      .sort((a, b) => b.count - a.count);

    const dates = docs
      .map((d) => d.payload.businessDate)
      .filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
      .sort();

    const balances = reconstructBalances(docs, { asOf });
    const groups = classifyGroups(docs, { asOf });
    const compared = crossCheck(docs, balances);

    const markdown = renderAuditReport({
      asOf,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      documentsAnalysed: docs.length,
      collectionCounts,
      dateRange: { earliest: dates[0] ?? null, latest: dates[dates.length - 1] ?? null },
      balances,
      groups,
      crossCheck: compared,
    });

    const outPath = join(process.cwd(), 'docs', 'reviews', `v1-audit-${asOf}.md`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, markdown, 'utf8');

    // Headline numbers on stdout — the same figures the report leads with, so a run is
    // legible without opening the file.
    const cannot = groups.groups.filter((g) => g.classification === 'cannot_balance');
    const ambiguous = groups.groups.filter((g) => g.classification === 'ambiguous');
    console.log('');
    console.log(`  groups analysed      ${groups.groups.length.toLocaleString()}`);
    console.log(`  balance              ${(groups.groups.length - cannot.length - ambiguous.length).toLocaleString()}`);
    console.log(`  ambiguous            ${ambiguous.length.toLocaleString()}`);
    console.log(`  CANNOT balance       ${cannot.length.toLocaleString()}`);
    console.log(`  cross-check rows     ${compared.accountRows.length.toLocaleString()}`);
    console.log(`  disagreements        ${compared.disagreements.length.toLocaleString()}`);
    console.log(`  data findings        ${(balances.findings.length + groups.findings.length).toLocaleString()}`);
    console.log('');
    console.log(`Report written: ${outPath}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
