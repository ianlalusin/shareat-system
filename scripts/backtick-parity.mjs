#!/usr/bin/env node
/**
 * Backtick-parity sweep over the Markdown tables that carry this project's record.
 *
 * WHY THIS EXISTS (DEF-345): a shell heredoc or an `-e` string EXECUTES backticks, and
 * `node -e "…"` is an `-e` string. When a document edit is built inside one, every
 * `` `identifier` `` is run as a command and replaced by its (empty) output — the command
 * still exits 0, so the only signal is a stray "command not found" above it. The surviving
 * backticks then close around whatever prose sat between them.
 *
 * That happened on 2026-09-10 in commit 998accb and destroyed the per-file list inside
 * DEF-258's register row. Nobody noticed for three days, and nobody swept for other
 * casualties when the trap was finally written down — which is the whole of DEF-345.
 *
 * An odd number of backticks in a single-line Markdown table row is an ANOMALY: a row whose
 * spans are balanced has an even count. ⛔ It is NOT a diagnosis, and saying so cost a
 * session on 2026-09-14. DEF-345 read an odd row as proof a shell had eaten its identifiers
 * and filed a repair job; the identifiers were present the whole time, at HEAD and in the
 * commit blamed. The real cause was a regex carrying a LITERAL BACKTICK inside its own
 * character class, span-closing everything after it — so the row rendered its prose as code
 * and its code as prose, which is exactly what "eaten by a shell" looks like.
 *
 * ⭐ So an odd count has at least two causes and this script cannot tell them apart:
 *   1. content genuinely consumed by a shell before it was written (the DEF-345 hypothesis);
 *   2. a legitimately backticked regex, path or glob written inline (the DEF-258 reality).
 * READ THE RAW TEXT of the flagged row before concluding which. If the named identifiers are
 * still there, nothing was lost and the fix is to re-spell the literal backtick (`\x60` for a
 * regex, a doubled-backtick span otherwise) — never to exempt the row.
 *
 * ⚠️ This is deliberately a FILE and not a one-liner. The control is the method, not the
 * memory: Write a plain file, run a script that READS it. An inline sweep for the backtick
 * trap is itself vulnerable to the backtick trap.
 *
 * Usage:  node scripts/backtick-parity.mjs [files...]
 *         node scripts/backtick-parity.mjs            (the three files of record)
 * Exit:   0 all balanced · 1 an odd row found · 2 a file could not be read
 */
import { readFileSync } from 'node:fs';

const DEFAULT_FILES = [
  'docs/DEFECTS-REGISTER.md',
  'PROJECT_BIBLE.md',
  'docs/HANDOFF-TODAY.md',
  'docs/CAPABILITY-GAPS.md',
];

const BACKTICK = String.fromCharCode(96);
const files = process.argv.slice(2);
const targets = files.length > 0 ? files : DEFAULT_FILES;

let failed = false;
let unreadable = false;

for (const file of targets) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`${file}  UNREADABLE: ${error.message}`);
    unreadable = true;
    continue;
  }

  const odd = [];
  text.split(/\r?\n/).forEach((line, index) => {
    // Table rows only. A fenced code block legitimately carries unbalanced backticks,
    // and prose spanning two lines does too; a `| … |` row is one line by construction.
    if (!line.startsWith('| ')) return;
    const count = (line.match(new RegExp(BACKTICK, 'g')) ?? []).length;
    if (count % 2 === 1) odd.push({ line: index + 1, count });
  });

  if (odd.length === 0) {
    console.log(`${file}  ok`);
  } else {
    failed = true;
    console.log(`${file}  ODD PARITY on ${odd.length} row(s):`);
    for (const row of odd) {
      console.log(`    line ${row.line} — ${row.count} backticks (expected an even count)`);
    }
  }
}

if (unreadable) process.exit(2);
if (failed) {
  console.log('');
  console.log('An odd row is an ANOMALY, not a verdict. Read the RAW TEXT before concluding.');
  console.log('  Are the identifiers the row names still present?');
  console.log('    YES -> nothing was lost. Something inline carries a literal backtick (a regex');
  console.log('           class, a glob). Re-spell it: \\x60 in a regex, a doubled-backtick span');
  console.log('           otherwise. Do NOT exempt the row, and do NOT delete content to balance it.');
  console.log('    NO  -> content really was consumed before it was written. Re-derive it from its');
  console.log('           source and record the method, not just the result.');
  console.log('DEF-345 is the standing proof that guessing between these two costs a session.');
  process.exit(1);
}
