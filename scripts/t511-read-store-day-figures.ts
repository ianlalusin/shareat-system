/**
 * T-511 slice 1, exit criterion 5 - READ-ONLY: what staff recorded for a store, channel and day.
 *
 * PURPOSE
 *   Slice 3 compares the platform's order value (Grab "Amount", Foodpanda column K) with the figure staff recorded
 *   for that store, channel and day. Before building that, we must know whether the two match on a real day, because
 *   the answer decides whether the Grab merchant-funded discount is booked (docs/tasks/511-settlement-upload-s1-spec.md
 *   section 7 item 5 and section 8 ruling 3). This script prints the staff-recorded side. The file side is in
 *   docs/discovery/t511-exit5-store-day-comparison.md. A person compares them by hand.
 *
 * WHERE THE FIGURE LIVES (and why this reads v1 Firestore, not Postgres)
 *   Staff record channel sales in v1: `stores/{storeId}/salesDays/{YYYY-MM-DD}.salesChannelBreakdown[channelId]`,
 *   with the channel names in `stores/{storeId}.salesChannels[]`. v1 stays the book of record until the cutover
 *   (docs/ops/cutover-runbook.md, "Freeze"), and the v2 database holds only trial data that the cutover purge removes
 *   (packages/db/src/cutover/classification.ts, sales_days). v2 does not double-enter sales
 *   (docs/plans/remaining-build-plan.md Q3). So the only certain home of an October figure is v1 Firestore.
 *
 * READ-ONLY, BY CONSTRUCTION
 *   1. The only client is `makeReadOnlyV1Client` (packages/etl/src/master-data/snapshot.ts). It exposes
 *      `collection(path).get()` and nothing else: there is no set, update, delete, add or batch to call.
 *   2. Every read first passes `assertReadablePath` (scripts/lib/t511-store-day-figures.ts): only `stores` and
 *      `stores/<id>/salesDays` can be read. Any other path throws before a call is made.
 *   3. No file is written. No other system is contacted. No database connection is opened.
 *   4. The service account key is read from a local file and handed straight to the Firebase SDK. Its value is never
 *      printed, logged, echoed or placed in an error. A missing key stops the run with one fixed sentence.
 *   5. Every failure prints one fixed sentence plus a short error code. The error's own message is never printed.
 *   6. Output is limited to: the store name and id, channel names and ids, the date, status, verified or not, and
 *      amounts. No names of people, reasons or notes are copied out of any document.
 *
 * HOW IAN RUNS IT (from the repo checkout that has node_modules installed, in his own terminal)
 *   npx tsx scripts/t511-read-store-day-figures.ts
 *   npx tsx scripts/t511-read-store-day-figures.ts --store Lipa --channels Grab,Foodpanda --dates 2026-10-12,2026-10-20
 *   Other options: --store-id <v1 store id> (exact; use it if the name matches more than one store).
 *   The key: by default the script reads FIREBASE_SERVICE_ACCOUNT_KEY from the v1 project's .env.local, exactly as
 *   `npm run dual-run -- extract` does (scripts/dual-run.ts, V1_ENV). Nothing needs to be exported first. To point at
 *   another file, set T511_V1_ENV_FILE=<path to a .env file holding FIREBASE_SERVICE_ACCOUNT_KEY> in your own shell.
 *   Do NOT paste the key, the file's contents or any connection string into chat. Paste only this script's output.
 *
 * EXPECTED OUTPUT SHAPE (figures, ids, names only)
 *   Store: <name> (v1 store id <id>)
 *   Channel pattern "Grab": "<channel name>" channelId <id>, active, not remitted daily (platform settles later)
 *   Channel pattern "Foodpanda": "<channel name>" channelId <id>, active, not remitted daily (...)
 *   Date 2026-10-12  stores/<store id>/salesDays/2026-10-12  FOUND
 *     status: verified   verified or later: yes   verifiedAt: <ISO time>
 *     admin adjustments: no
 *     totalSales <n>   sum of salesChannelBreakdown <n>
 *     discount columns on the day: totalDiscounts <n>, seniorDiscount <n>, pwdDiscount <n>, otherDiscount <n>, comps <n>
 *     legacy summary fields: foodpandaSales <n>, grabSales <n>, otherSales <n>
 *     channel "<name>" (channelId <id>, matched "Grab")
 *       RECORDED salesChannelBreakdown[<id>] = <n>
 *   ...one block per date; "NOT FOUND" when no sales day exists for that date.
 */
import { readFileSync } from 'node:fs';
import {
  DEFAULT_DATES,
  SafeRefusal,
  extractDayFigures,
  formatDayReport,
  formatStoreHeader,
  makeGuardedReader,
  matchChannels,
  parseArgs,
  pickStore,
  safeFailureLine,
  toStoreRef,
} from './lib/t511-store-day-figures';

const DEFAULT_V1_ENV = 'C:/Users/ianla/webapps/ERP-rebuild/.env.local';
const KEY_NAME = 'FIREBASE_SERVICE_ACCOUNT_KEY';

/** The key text from a .env file, or undefined. The text is returned to the caller and never printed here. */
function readKeyText(): string | undefined {
  const file = process.env.T511_V1_ENV_FILE?.trim() || DEFAULT_V1_ENV;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined; // the path and the reason are not printed
  }
  return new RegExp(`^${KEY_NAME}=(.*)$`, 'm').exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || undefined;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2)); // before any key is read

  const keyText = readKeyText();
  if (!keyText) {
    throw new SafeRefusal(
      `Refused: ${KEY_NAME} was not found in the v1 .env file. Set T511_V1_ENV_FILE to a file that holds it, or restore the default v1 .env.local.`,
    );
  }

  const { makeReadOnlyV1Client, parseServiceAccountKey } = await import('../packages/etl/src/master-data/snapshot');
  const { default: admin } = await import('firebase-admin');
  const app = admin.initializeApp({ credential: admin.credential.cert(parseServiceAccountKey(keyText) as never) }, 't511-read-store-day-figures');

  try {
    const reader = makeGuardedReader(makeReadOnlyV1Client(admin.firestore(app)));

    const roster = (await reader.readCollection('stores')).map(toStoreRef);
    const store = pickStore(roster, opts);
    const matches = matchChannels(store, opts.channels);
    const channels = matches.flatMap((m) => m.channels);
    const patternByChannelId = new Map(matches.flatMap((m) => m.channels.map((c) => [c.channelId, m.pattern] as const)));

    for (const line of formatStoreHeader(store, matches)) console.log(line);

    const days = new Map((await reader.readCollection(`stores/${store.id}/salesDays`)).map((d) => [d.id, d] as const));
    for (const date of opts.dates) {
      console.log('');
      for (const line of formatDayReport(extractDayFigures(date, days.get(date), channels), patternByChannelId)) console.log(line);
    }
    if (opts.dates.join() === DEFAULT_DATES.join()) {
      console.log('');
      console.log('Compare by hand with docs/discovery/t511-exit5-store-day-comparison.md. Do not paste anything except this output.');
    }
  } finally {
    await app.delete();
  }
}

main().catch((err: unknown) => {
  console.error(safeFailureLine(err));
  process.exitCode = 1;
});
