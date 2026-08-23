/**
 * Coverage + classification report — docs/tasks/117-replay-harness-stage-a.md Contract §1
 * and §5's "Emits a coverage report: classes full, classes short, classes empty."
 *
 * Two things this module reports on, kept separate on purpose:
 *   1. TAXONOMY COVERAGE — for each case class, how many specimens exist in the corpus
 *      versus its target. An empty class is flagged explicitly (Contract §1: "Empty
 *      classes are the most interesting output... the report must surface them rather
 *      than quietly showing 90% coverage") — never folded into an average.
 *   2. CONVERSION FINDINGS — for a set of `ConversionResult`s (typically "every specimen
 *      in the corpus, converted"), how many converted cleanly vs were skipped vs
 *      quarantined, and why. This is what the replay test's console output is built from
 *      (invariant 9: "or is reported with a reason").
 *
 * Pure functions only — no filesystem access here. `replay.test.ts` reads the corpus
 * directory itself and passes the resulting counts/results in, which keeps this module
 * trivially unit-testable without touching disk.
 */
import { ALL_CASE_CLASSES, isAnomalyClass, taxonomyEntry, type CaseClass } from './taxonomy';
import type { ConversionResult } from './convert';

export type CoverageStatus = 'full' | 'short' | 'empty' | 'uncapped';

export interface CoverageRow {
  caseClass: CaseClass;
  label: string;
  target: number | null;
  captured: number;
  status: CoverageStatus;
}

/**
 * `counts` maps case class -> number of specimens currently in the corpus for it
 * (typically: count of `.raw.json` files under `corpus/<class>/`). Classes absent from
 * `counts` are treated as zero, not skipped — an unmentioned class is exactly the "empty
 * class" case Contract §1 says must be surfaced, not silently omitted from the report.
 */
export function buildCoverageReport(counts: ReadonlyMap<CaseClass, number>): CoverageRow[] {
  return ALL_CASE_CLASSES.map((caseClass) => {
    const entry = taxonomyEntry(caseClass);
    const captured = counts.get(caseClass) ?? 0;
    let status: CoverageStatus;
    if (isAnomalyClass(caseClass)) {
      status = 'uncapped';
    } else if (captured === 0) {
      status = 'empty';
    } else if (entry.target !== null && captured >= entry.target) {
      status = 'full';
    } else {
      status = 'short';
    }
    return { caseClass, label: entry.label, target: entry.target, captured, status };
  });
}

export function formatCoverageReport(rows: readonly CoverageRow[]): string {
  const lines: string[] = ['Corpus coverage:'];
  for (const row of rows) {
    const targetLabel = row.target === null ? 'uncapped' : `${row.captured}/${row.target}`;
    const flag = row.status === 'empty' ? '  <-- EMPTY' : '';
    lines.push(`  [${row.status.padEnd(7)}] ${row.caseClass.padEnd(24)} ${targetLabel.padEnd(10)} ${row.label}${flag}`);
  }
  const empty = rows.filter((r) => r.status === 'empty');
  if (empty.length > 0) {
    lines.push('', `${empty.length} class(es) with ZERO specimens — a finding to investigate, not a gap to hide:`);
    for (const row of empty) lines.push(`  - ${row.caseClass}: ${row.label}`);
  }
  return lines.join('\n');
}

// -----------------------------------------------------------------------------------------
// Conversion findings
// -----------------------------------------------------------------------------------------

export interface ConversionSummary {
  total: number;
  converted: number;
  skipped: number;
  quarantined: number;
  findings: { specimenId: string; caseClass: CaseClass; status: string; reason: string }[];
}

export function summarizeConversions(results: readonly ConversionResult[]): ConversionSummary {
  const findings: ConversionSummary['findings'] = [];
  let converted = 0;
  let skipped = 0;
  let quarantined = 0;

  for (const r of results) {
    if (r.status === 'converted') converted++;
    if (r.status === 'skipped') {
      skipped++;
      findings.push({ specimenId: r.specimenId, caseClass: r.caseClass, status: r.status, reason: r.reason ?? '(no reason given)' });
    }
    if (r.status === 'quarantined') {
      quarantined++;
      findings.push({ specimenId: r.specimenId, caseClass: r.caseClass, status: r.status, reason: r.reason ?? '(no reason given)' });
    }
  }

  return { total: results.length, converted, skipped, quarantined, findings };
}

export function formatConversionSummary(summary: ConversionSummary): string {
  const lines = [
    `Conversion summary: ${summary.total} specimen(s) — ` +
      `${summary.converted} converted, ${summary.skipped} skipped, ${summary.quarantined} quarantined.`,
  ];
  for (const f of summary.findings) {
    lines.push(`  [${f.status}] ${f.specimenId} (${f.caseClass}): ${f.reason}`);
  }
  return lines.join('\n');
}
