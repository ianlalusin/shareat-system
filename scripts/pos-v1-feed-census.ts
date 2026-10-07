/**
 * T-375 S0 - census of live POS data, READ-ONLY. `docs/tasks/375-pos-v1-day-feed.md` S0.
 *
 *     F=/srv/shareat-shared/.env.local; get(){ grep -m1 "^$1=" "$F" | cut -d= -f2- | tr -d '\r' | sed -e "s/^[\"']//" -e "s/[\"']$//"; }; cd /srv/shareat && POS_API_URL="$(get POS_API_URL)" POS_API_KEY="$(get POS_API_KEY)" npx tsx scripts/pos-v1-feed-census.ts --pos-store L5MExycvUOfQ96Y10FqF
 *   (options: --pos-store <id> repeatable, --days 90, --to YYYY-MM-DD)
 *
 * Needs POS_API_URL and POS_API_KEY in the environment. For each store and each of the last N days (default 90, ending
 * `--to`, default yesterday in Manila) it GETs /api/external/sales, and /api/external/payment-methods once per store,
 * and prints COUNTS only (the classification lives in `v1-census.ts`, which reads a day exactly as R4 does). It prints
 * no body, no URL, never the key; a non-2xx prints the status and the date. No database, no writes. Sequential, with a
 * short pause between calls.
 *
 * Exit 0 = every store's gate passed; 1 = a gate failed; 2 = could not run (bad arguments, POS not configured, a store
 * that could not be read at all).
 */
import { POS_V1_FEED_PATHS, POS_V1_PAYMENT_METHODS_PATH } from '@shareat/db';
import { addDays, parseBusinessDate, toBusinessDate } from '@shareat/core/datetime';
import { addDay, censusGate, classifyDay, emptyCensus, formatCensus } from '@shareat/domain/pos/v1-census';

const TIMEOUT_MS = 15_000;
const PAUSE_MS = 150;

interface Args {
  stores: string[];
  days: number;
  to: string;
}

function parseArgs(argv: string[]): Args | string {
  const stores: string[] = [];
  let days = 90;
  let to = addDays(toBusinessDate(), -1) as string;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--pos-store' && v) { stores.push(v); i++; }
    else if (a === '--days' && v) {
      days = Number(v);
      if (!Number.isInteger(days) || days < 1 || days > 400) return '--days must be a whole number from 1 to 400';
      i++;
    } else if (a === '--to' && v) {
      try { to = parseBusinessDate(v) as string; } catch { return '--to must be a date, YYYY-MM-DD'; }
      i++;
    } else return `unknown or incomplete argument: ${a}`;
  }
  if (stores.length === 0) return 'at least one --pos-store <id> is required';
  return { stores, days, to };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET -> { status, json }. Never throws and never carries the URL or key into a message. */
async function get(base: string, key: string, path: string, query: string): Promise<{ status: number; json: unknown }> {
  try {
    const res = await fetch(`${base}${path}?${query}`, { headers: { 'x-api-key': key }, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { status: res.status, json: null };
    try { return { status: res.status, json: await res.json() }; } catch { return { status: 0, json: null }; }
  } catch {
    return { status: 0, json: null };
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') { console.error(`census: ${args}`); return 2; }
  const url = process.env.POS_API_URL?.replace(/\/+$/, '');
  const key = process.env.POS_API_KEY;
  if (!url || !key) { console.error('census: POS_API_URL or POS_API_KEY is not set'); return 2; }

  let exit = 0;
  for (const store of args.stores) {
    const census = emptyCensus();
    const q = (d: string) => `storeId=${encodeURIComponent(store)}&date=${encodeURIComponent(d)}`;

    const methods = await get(url, key, POS_V1_PAYMENT_METHODS_PATH, `storeId=${encodeURIComponent(store)}`);
    const listed = (methods.json as { methods?: unknown } | null)?.methods;
    const listedCount = Array.isArray(listed) ? listed.length : null;
    if (methods.status === 0 || methods.status >= 300) console.error(`store ${store}: payment-methods answered ${methods.status || 'no response'}`);

    let failedStatus = 0;
    for (let i = args.days - 1; i >= 0; i--) {
      const date = addDays(parseBusinessDate(args.to), -i) as string;
      const r = await get(url, key, POS_V1_FEED_PATHS.sales, q(date));
      if (r.status < 200 || r.status >= 300 || r.json === null) {
        census.failedDays += 1;
        census.days += 1;
        failedStatus = r.status;
        console.error(`store ${store}: ${date} answered ${r.status || 'no usable response'}`);
      } else {
        addDay(census, classifyDay(r.json));
      }
      await sleep(PAUSE_MS);
    }

    console.log(formatCensus(store, census, args.days));
    if (listedCount !== null) console.log(`payment-methods listed by POS: ${listedCount}`);
    if (census.failedDays === census.days) { console.error(`store ${store}: no day could be read (last status ${failedStatus || 'none'})`); exit = Math.max(exit, 2); }
    else if (!censusGate(census).pass) exit = Math.max(exit, 1);
  }
  return exit;
}

main().then(
  (code) => process.exit(code),
  () => { console.error('census: failed unexpectedly'); process.exit(2); },
);
