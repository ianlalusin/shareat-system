/**
 * T-375 S3 (V13, W10) - the DEV fake POS: a stand-in for POS v1's `/api/external/*` bridge, inside the ERP on 9008
 * (no new port). `docs/tasks/375-pos-v1-day-feed.md` S3.
 *
 * Point the import at it with `POS_API_URL=http://localhost:9008/api/dev/fake-pos`, `POS_API_KEY=<anything>` and
 * `POS_FAKE_ENABLED=1`. It serves `stores`, `payment-methods`, `sales` and `sold-items` from
 * `apps/erp/dev-fixtures/pos-v1/` (`stores.json`; `{posStoreId}/payment-methods.json`;
 * `{posStoreId}/{date}.sales.json`; `{posStoreId}/{date}.sold-items.json`), each file's text AS IS.
 *
 * The gates, in order:
 *  - 404 unless `NODE_ENV !== 'production'` AND `POS_FAKE_ENABLED === '1'` (the flag never unlocks production);
 *  - 401 unless `x-api-key` equals `POS_API_KEY`;
 *  - 404 for an unknown route name;
 *  - 400 unless `storeId` matches `^[A-Za-z0-9_-]{1,64}$` (and `date` `^\d{4}-\d{2}-\d{2}$` where a route takes one).
 * No file path is ever built from anything but those two validated values. The route asks for no session: it is a
 * server-to-self call (`proxy.ts` matches only `/clock`). It never names a POS wire field: it serves bytes.
 */
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const STORE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `apps/erp/dev-fixtures/pos-v1`, whether the server runs from `apps/erp` or from the repo root. */
function fixturesDir(): string {
  const here = path.resolve(process.cwd(), 'dev-fixtures', 'pos-v1');
  if (existsSync(here)) return here;
  return path.resolve(process.cwd(), 'apps', 'erp', 'dev-fixtures', 'pos-v1');
}

function sameKey(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (text: string, status = 200) =>
  new Response(text, { status, headers: { 'content-type': 'application/json' } });
const plain = (status: number, message: string) => json(JSON.stringify({ error: message }), status);

export async function GET(req: Request, ctx: { params: Promise<{ route: string }> }): Promise<Response> {
  if (process.env.NODE_ENV === 'production' || process.env.POS_FAKE_ENABLED !== '1') return plain(404, 'Not found');
  if (!sameKey(req.headers.get('x-api-key'), process.env.POS_API_KEY)) return plain(401, 'Unauthorized');

  const { route } = await ctx.params;
  if (route !== 'stores' && route !== 'payment-methods' && route !== 'sales' && route !== 'sold-items') {
    return plain(404, 'Not found');
  }

  const query = new URL(req.url).searchParams;
  let file: string;
  if (route === 'stores') {
    file = path.join(fixturesDir(), 'stores.json');
  } else {
    const storeId = query.get('storeId') ?? '';
    if (!STORE_ID.test(storeId)) return plain(400, 'storeId is missing or not valid');
    if (route === 'payment-methods') {
      file = path.join(fixturesDir(), storeId, 'payment-methods.json');
    } else {
      const date = query.get('date') ?? '';
      if (!DATE.test(date)) return plain(400, 'date must be YYYY-MM-DD');
      const kind = route === 'sales' ? 'sales' : 'sold-items';
      file = path.join(fixturesDir(), storeId, `${date}.${kind}.json`);
    }
  }

  try {
    return json(await readFile(file, 'utf8'));
  } catch {
    return plain(404, 'No fixture for that request');
  }
}
