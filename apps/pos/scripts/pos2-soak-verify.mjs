#!/usr/bin/env node
// T-425 Ruling 10 - the two-tablet soak verifier. READ-ONLY, run by a person after a real soak (never by a build or a request).
//
//   POS_FIREBASE_SA_KEY_FILE=<service-account.json> node apps/pos/scripts/pos2-soak-verify.mjs --store=<pos store id> --terminal=<1-99> [--skipped=7,9]
//
// Lists the receipt numbers THIS terminal wrote to the server and labels every gap in its number series:
//   skipped  a `skipped` event exists in the tablet's ledger (an online sale that failed for good: no money). Pass those sequence numbers with --skipped.
//   MISSING  nothing explains the gap: a sale that never reached the server, or a receipt that was deleted.
// and lists any receipt number that appears more than once. It only ever calls `.get()`: no write of any kind.
// Exit code 0 when there is no MISSING number and no duplicate, 2 when there is, 1 on a usage or connection error.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** `<CODE>-<TT>-<NNNNNN>` -> NNNNNN as a number (NaN when it does not end in digits). */
const seqOf = (receiptNumber) => Number(String(receiptNumber).split('-').pop());

/**
 * Pure core (tested without Firestore). `receiptNumbers`: the numbers of ONE terminal, `skippedSeqs`: its ledger's skipped sequence numbers.
 * Returns the lowest and highest PRESENT sequence, how many distinct sequences are present, every gap in the range (lowest to highest of
 * everything seen, receipts and skipped alike) with its label, and the receipt numbers that appear more than once.
 */
export function classifyTerminalReceipts({ receiptNumbers, skippedSeqs }) {
  const seen = {};
  for (const n of receiptNumbers) seen[n] = (seen[n] ?? 0) + 1;
  const duplicates = Object.keys(seen).filter((n) => seen[n] > 1).sort();
  const presentSeqs = [...new Set(receiptNumbers.map(seqOf).filter((s) => Number.isInteger(s)))];
  const skipped = [...new Set(skippedSeqs)];
  const all = [...presentSeqs, ...skipped];
  if (all.length === 0) return { first: null, last: null, present: 0, gaps: [], duplicates };
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const gaps = [];
  for (let s = lo; s <= hi; s++) {
    if (presentSeqs.includes(s)) continue;
    gaps.push({ terminalSeq: s, label: skipped.includes(s) ? 'skipped' : 'MISSING' });
  }
  return {
    first: presentSeqs.length ? Math.min(...presentSeqs) : null,
    last: presentSeqs.length ? Math.max(...presentSeqs) : null,
    present: presentSeqs.length,
    gaps,
    duplicates,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
  const [storeId] = flag('store');
  const [terminal] = flag('terminal');
  const skippedSeqs = (flag('skipped')[0] ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  const keyFile = (process.env.POS_FIREBASE_SA_KEY_FILE ?? '').trim();
  const terminalNo = Number(terminal);
  if (!keyFile || !storeId || !Number.isInteger(terminalNo) || terminalNo < 1 || terminalNo > 99 || skippedSeqs.some((s) => !Number.isInteger(s))) {
    console.error('Usage: POS_FIREBASE_SA_KEY_FILE=<service-account.json> node apps/pos/scripts/pos2-soak-verify.mjs --store=<pos store id> --terminal=<1-99> [--skipped=7,9]');
    process.exit(1);
  }
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const credential = JSON.parse(readFileSync(keyFile, 'utf8'));
  const app = initializeApp({ credential: cert(credential), projectId: credential.project_id }, 'pos2-soak-verify');
  const db = getFirestore(app);

  const snap = await db.collection(`stores/${storeId}/receipts`).where('terminalNo', '==', terminalNo).get();
  const receiptNumbers = snap.docs.map((d) => String(d.data().receiptNumber ?? '')).filter(Boolean);
  const r = classifyTerminalReceipts({ receiptNumbers, skippedSeqs });

  console.log(`store ${storeId}  terminal ${String(terminalNo).padStart(2, '0')}`);
  console.log(`receipts on the server: ${r.present}${r.first === null ? '' : `  (sequence ${r.first} to ${r.last})`}`);
  for (const g of r.gaps) console.log(`  gap at ${g.terminalSeq}: ${g.label}`);
  for (const n of r.duplicates) console.log(`  DUPLICATE receipt number: ${n}`);
  const missing = r.gaps.filter((g) => g.label === 'MISSING').length;
  console.log(missing === 0 && r.duplicates.length === 0 ? 'pos2-soak-verify: every number is explained and none is duplicated.' : `pos2-soak-verify: ${missing} MISSING, ${r.duplicates.length} duplicate.`);
  process.exit(missing === 0 && r.duplicates.length === 0 ? 0 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`pos2-soak-verify failed: ${e?.message ?? e}`); process.exit(1); });
}
