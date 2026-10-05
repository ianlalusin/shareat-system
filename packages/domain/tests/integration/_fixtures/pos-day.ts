import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { Actor } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import { posV1SalesBody, posV1SoldItemsBody, type PosV1SalesFigures, type PosV1SoldItemInput } from '../../../../db/src/pos-v1/fixtures';

/**
 * T-375 S3 - test helpers for a store LINKED to POS v1 and a day IMPORTED from it (docs/tasks/375-pos-v1-day-feed.md,
 * S3 TESTER list). Used by NEW tests and by any existing test whose store gets linked; unlinked-store tests keep
 * `createSalesDay` (V2b).
 *
 * USED ONLY BY the S3 tests (t375-s3-import, oil-wave-2) while `importSalesDay` does not exist: `importTestDay` loads
 * `sales-days/import` dynamically, so a missing module fails the leg that calls it, never the file's import line.
 *
 * Assumed shape of the target (the spec is silent; the builder reconciles, never the tests):
 *   importSalesDay(tx, actor, { storeId, businessDate }, fetchers?) -> Promise<{ id: string }>
 *   fetchers = { sales: PosV1DayFetcher; soldItems: PosV1DayFetcher }   (each called with { posStoreId, businessDate, kind })
 */

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

/** The spec's D1 day: P 1,050.00, D 100.00, C 50.00, K 600.00, methods {Cash 700.00, GCash 350.00}, N 20. */
export const D1_FIGURES: PosV1SalesFigures = {
  paidTotal: 1050,
  discounts: 100,
  charges: 50,
  packageOnly: 600,
  receiptCount: 20,
  methods: { Cash: 700, GCash: 350 },
  // A DECOY in POS's residual field (a trap name, R12: never spelled in v2 source). The derivation must never read
  // it: a mutant that takes a la carte from it makes D1 red. Built by concatenation on purpose.
  extra: { ['take' + 'Out' + 'Sales']: 123.45 },
};

/** D2b: a 100.00 refund day (P 950.00 against methods that still total 1,050.00). */
export const D2B_FIGURES: PosV1SalesFigures = { ...D1_FIGURES, paidTotal: 950 };

export const D1_SOLD_ITEMS: readonly PosV1SoldItemInput[] = [{ key: 'item-a', physicalQty: 3, grossAmount: 300 }];

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Link a v2 store to a POS store, by raw SQL (the link is the store's switch, I10). Returns the POS store id used. */
export async function linkTestStore(
  sql: postgres.Sql,
  o: {
    orgId: string;
    storeId: string;
    channelId: string;
    createdBy: string;
    posStoreId?: string;
    posStoreName?: string;
    taxType?: 'vat_inclusive' | 'vat_exclusive' | 'non_vat';
  },
): Promise<{ posStoreId: string; linkId: string }> {
  const posStoreId = o.posStoreId ?? uid('pos-store');
  const [row] = await sql<{ id: string }[]>`
    insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
    values (${o.orgId}, ${o.storeId}, ${posStoreId}, ${o.posStoreName ?? 'Test POS store'}, ${o.channelId}, ${o.taxType ?? 'vat_inclusive'}, ${o.createdBy})
    returning id`;
  return { posStoreId, linkId: row!.id };
}

/** Cash (cash, alias Cash) and GCash (wallet -> `walletAccountId`, alias GCash) for a store, both active. */
export async function seedTestTenders(
  sql: postgres.Sql,
  o: { orgId: string; storeId: string; walletAccountId: string; extra?: readonly { name: string; alias: string; accountId: string }[] },
): Promise<{ cashTenderId: string; walletTenderId: string }> {
  const [cash] = await sql<{ id: string }[]>`
    insert into tenders (org_id, store_id, name, kind, pos_v1_alias) values (${o.orgId}, ${o.storeId}, 'Cash', 'cash', 'Cash') returning id`;
  const [wallet] = await sql<{ id: string }[]>`
    insert into tenders (org_id, store_id, name, kind, money_account_id, pos_v1_alias)
    values (${o.orgId}, ${o.storeId}, 'GCash', 'wallet', ${o.walletAccountId}, 'GCash') returning id`;
  for (const x of o.extra ?? []) {
    await sql`
      insert into tenders (org_id, store_id, name, kind, money_account_id, pos_v1_alias)
      values (${o.orgId}, ${o.storeId}, ${x.name}, 'wallet', ${x.accountId}, ${x.alias})`;
  }
  return { cashTenderId: cash!.id, walletTenderId: wallet!.id };
}

export interface FeedCall {
  readonly kind: string;
  readonly posStoreId: string;
  readonly businessDate: string;
}

export interface StubFetchOptions {
  /** The `sales` figures, or a function of the requested date. Default D1. */
  readonly figures?: PosV1SalesFigures | ((businessDate: string) => PosV1SalesFigures);
  readonly soldItems?: readonly PosV1SoldItemInput[];
  /** Every fetch throws this (the fetcher "is unreachable / not configured"). */
  readonly failWith?: Error;
}

/**
 * Recording fetchers: each call is logged BEFORE it answers, and `bodies` keeps the exact text returned. The body is
 * pretty-printed JSON on purpose, so it can never equal a re-serialisation of the stored jsonb payload.
 */
export function stubFetchers(o: StubFetchOptions = {}) {
  const calls: FeedCall[] = [];
  const bodies: { sales: string[]; sold_items: string[] } = { sales: [], sold_items: [] };
  const make =
    (kind: 'sales' | 'sold_items') =>
    async (input: { posStoreId: string; businessDate: string; kind?: string }) => {
      calls.push({ kind, posStoreId: input.posStoreId, businessDate: input.businessDate });
      if (o.failWith) throw o.failWith;
      let obj: Record<string, unknown>;
      if (kind === 'sales') {
        const figs = typeof o.figures === 'function' ? o.figures(input.businessDate) : (o.figures ?? D1_FIGURES);
        obj = posV1SalesBody(figs);
      } else {
        obj = posV1SoldItemsBody(o.soldItems ?? D1_SOLD_ITEMS);
      }
      const body = JSON.stringify(obj, null, 2);
      bodies[kind].push(body);
      return { body, payload: JSON.parse(body) as unknown };
    };
  return { fetchers: { sales: make('sales'), soldItems: make('sold_items') }, calls, bodies };
}

/** Import one day through `importSalesDay` with recording fetchers; returns the day id and what the fetchers saw. */
export async function importTestDay(
  tx: Tx,
  actor: Actor,
  o: {
    storeId: string;
    businessDate: string;
    figures?: StubFetchOptions['figures'];
    soldItems?: readonly PosV1SoldItemInput[];
    fetchers?: ReturnType<typeof stubFetchers>['fetchers'];
  },
) {
  const { importSalesDay } = (await import('../../../src/sales-days/import')) as unknown as {
    importSalesDay: (
      tx: Tx,
      actor: Actor,
      input: { storeId: string; businessDate: string },
      fetchers?: unknown,
    ) => Promise<{ id: string }>;
  };
  const stub = stubFetchers({ figures: o.figures, soldItems: o.soldItems });
  const result = await importSalesDay(tx, actor, { storeId: o.storeId, businessDate: o.businessDate }, o.fetchers ?? stub.fetchers);
  return { ...result, calls: stub.calls, bodies: stub.bodies };
}
