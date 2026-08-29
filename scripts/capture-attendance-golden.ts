/**
 * scripts/capture-attendance-golden.ts — the T-157 golden corpus. D4, approved by Ian 2026-08-29.
 *
 * Reads v1's `attendanceSessions` plus each store's `attendanceConfig`, and writes the fixture
 * `tests/golden/fixtures/attendance-sessions.json` that the golden master replays.
 *
 * ⚠️ **Committed and re-runnable, not a console one-off** — bible §11 rule 1.
 * ⚠️ **Read-only.** It counts first, then reads; it never writes to Firestore, and `SourceReader`
 *     declares no write method at all.
 *
 * ## ⭐ It carries NO staff identifier, so there is nothing to pseudonymise
 *
 * The golden master compares arithmetic: taps in, hours out. `staffId`, names and every other
 * identifier are dropped at the boundary rather than hashed — the strongest form of "dirty data is
 * surfaced, not silently coerced" is data that never leaves the source. The specimen id is the
 * store's short code plus an ordinal.
 *
 * Usage:
 *   npm run capture:attendance-golden
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createErpFirestoreClient } from '../packages/etl-firestore/src/client';

/** The four operating stores (docs/STORE-ROSTER.md). Davao had 0 sessions at capture time. */
const STORES: readonly { id: string; code: string }[] = [
  { id: 'b9DzsnPbr1BUnY88lyT4', code: 'lipa' },
  { id: 'dZUyvX4q824JBSVDAfE9', code: 'malvar' },
  { id: 'iGOW7q2pZbeHWV832UNh', code: 'banay' },
  { id: 'eVYKj6wABdakk8RgEotW', code: 'davao' },
];

const OUT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tests', 'golden', 'fixtures', 'attendance-sessions.json');

interface Specimen {
  id: string;
  sessionDate: string;
  rawClockInMs: number;
  rawClockOutMs: number;
  breakMinutes?: number;
  config: Record<string, unknown>;
  expected: {
    computedHours: number;
    shiftStartHour: number | null;
    startAnchorMode: 'exact' | 'previous' | 'next' | 'unallowed';
    isHalfDay: boolean;
    nightDiffHours: number;
  };
  /** v1 fields kept for triage only — never asserted against. */
  context: Record<string, unknown>;
}

async function main() {
  const client = createErpFirestoreClient();
  if ('skipped' in client) {
    // ⚠️ Never print the credential itself — only which variable is missing.
    console.error(`Cannot read v1: ${client.reason}`);
    console.error(`Missing: ${client.missing.join(', ') || '(none reported)'}`);
    process.exit(1);
  }
  // ⚠️ `FirestoreClientLike` is the narrow read surface the ETL declares (deliberately: it has no
  // write method at all, which is what makes "the ETL cannot mutate the source" structural rather
  // than intended). Reading a single store DOCUMENT is outside that surface, so the cast is
  // explicit and local rather than widening the shared interface for one script.
  const db = client.firestore as unknown as {
    collection(path: string): {
      get(): Promise<{ docs: { id: string; data(): unknown }[] }>;
      doc(id: string): { get(): Promise<{ data(): unknown }> };
    };
  };

  const specimens: Specimen[] = [];
  const skipped: Record<string, number> = {};
  const note = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };

  for (const store of STORES) {
    const storeDoc = await db.collection('stores').doc(store.id).get();
    const attendanceConfig = (storeDoc.data() as Record<string, unknown> | undefined)?.attendanceConfig;
    if (!attendanceConfig) {
      note(`${store.code}: store has no attendanceConfig`);
      continue;
    }

    const snap = await db.collection(`stores/${store.id}/attendanceSessions`).get();
    let n = 0;
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>;

      // Only sessions with BOTH raw taps can be replayed — an unpaired day tests the anomaly path,
      // not the arithmetic, and v1's own outputs for one are not a meaningful comparison.
      const inMs = d.rawClockIn;
      const outMs = d.rawClockOut;
      if (typeof inMs !== 'number' || typeof outMs !== 'number') {
        note('no raw in/out pair');
        continue;
      }
      if (outMs === inMs) {
        // ⭐ A SINGLE TAP. v1's pairer sets rawClockOut = rawClockIn when a day has only one tap
        // ("equals rawClockIn if only one tap"), so the pair is an artifact rather than a shift.
        // v2 never sees this shape -- it stores punches, so one tap is one punch and the day is
        // `missing_out`. Excluded because replaying it compares two different things.
        // ⚠️ See DEF-088: v1 PAYS these. lipa-0245 is a lone 20:09 tap credited 2 hours.
        note('single tap (rawClockOut === rawClockIn) — see DEF-088');
        continue;
      }
      if (outMs < inMs) {
        note('out before in');
        continue;
      }
      if (d.status === 'voided') {
        note('voided');
        continue;
      }
      if (typeof d.sessionDate !== 'string') {
        note('no sessionDate');
        continue;
      }

      specimens.push({
        id: `${store.code}-${String(++n).padStart(4, '0')}`,
        sessionDate: d.sessionDate,
        rawClockInMs: inMs,
        rawClockOutMs: outMs,
        breakMinutes: typeof d.breakMinutes === 'number' ? d.breakMinutes : 0,
        config: attendanceConfig as Record<string, unknown>,
        expected: {
          computedHours: Number(d.computedHours ?? 0),
          shiftStartHour: d.shiftStartHour === null || d.shiftStartHour === undefined ? null : Number(d.shiftStartHour),
          startAnchorMode: (d.startAnchorMode as Specimen['expected']['startAnchorMode']) ?? 'previous',
          isHalfDay: Boolean(d.isHalfDay),
          nightDiffHours: Number(d.nightDiffHours ?? 0),
        },
        context: {
          status: d.status ?? null,
          source: d.source ?? null,
          cappedAtRequiredHours: Boolean(d.cappedAtRequiredHours),
          anomalies: d.anomalies ?? [],
          allowableBreakMinutes: d.allowableBreakMinutes ?? null,
          breakOverMinutes: d.breakOverMinutes ?? null,
        },
      });
    }
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(specimens, null, 2)}\n`, 'utf8');

  // ⭐ The reconciliation report. Bible §11 rule 3: "It ran without errors" is not evidence.
  console.log(`\nWrote ${specimens.length} specimens to ${OUT}`);
  console.log('Skipped, itemised:');
  for (const [why, count] of Object.entries(skipped).sort()) console.log(`  ${count.toString().padStart(5)}  ${why}`);
  const total = specimens.length + Object.values(skipped).reduce((a, b) => a + b, 0);
  console.log(`  ${String(total).padStart(5)}  TOTAL seen`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
