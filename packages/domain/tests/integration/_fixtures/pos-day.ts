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

/**
 * T-375 S4 - a feed-sourced sales day inserted by RAW SQL on a LINKED store, the way the 0185 lock lets only the
 * derivation write one: the transaction-local flag `app.sales_day_derivation` is turned on for the insert and off
 * after it (the same on-success-only shape as `withSalesDayDerivation`). On HEAD (no trigger) the flag is inert and
 * the insert simply works, so tests that use this helper stay green until a leg asserts a refusal.
 *
 * Pass a postgres.js TRANSACTION to run inside the caller's transaction; pass the pool and the helper opens its own
 * (a `set_config(..., true)` outside a transaction would not outlive its statement). A feed row is inserted for the
 * day unless `feedId` is given. Figures default to the spec's D1 day (total 1,100.00 = unli 600.00 + a la carte 500.00).
 * Returns `{ id, feedId }`.
 */
export async function insertDerivedSalesDayRow(
  tx: postgres.Sql | postgres.TransactionSql,
  row: {
    orgId: string;
    storeId: string;
    businessDate: string;
    createdBy: string;
    feedId?: string;
    posStoreId?: string;
    status?: 'open' | 'submitted' | 'verified' | 'voided';
    figures?: Partial<Record<'total_sales' | 'unli_sales' | 'ala_carte_sales' | 'other_discount' | 'other_charges' | 'refunds' | 'cash_collected' | 'online_collected', string>>;
  },
): Promise<{ id: string; feedId: string }> {
  const run = async (t: postgres.Sql | postgres.TransactionSql) => {
    let feedId = row.feedId;
    if (!feedId) {
      const [feed] = await t<{ id: string }[]>`
        insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_at, fetched_by)
        values (${row.orgId}, ${row.storeId}, ${row.businessDate}, 'sales', 'import', ${crypto.randomUUID()}, ${row.posStoreId ?? 'pos-fixture'},
                '{"found":true}', '{"found":true}'::jsonb, ${sha256(uid('feed'))}, now(), ${row.createdBy})
        returning id`;
      feedId = feed!.id;
    }
    const f = { total_sales: '1100.00', unli_sales: '600.00', ala_carte_sales: '500.00', other_discount: '100.00', other_charges: '50.00', refunds: '0.00', cash_collected: '700.00', online_collected: '350.00', ...row.figures };
    const status = row.status ?? 'open';
    await t`select set_config('app.sales_day_derivation', 'on', true)`;
    const [day] = await t<{ id: string }[]>`
      insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, other_discount, other_charges,
                              refunds, cash_collected, online_collected, source, pos_v1_day_feed_id, pos_sourced, pos_sourced_at, created_by,
                              verified_by, verified_at)
      values (${row.orgId}, ${row.storeId}, ${row.businessDate}, ${status}, ${f.total_sales}, ${f.unli_sales}, ${f.ala_carte_sales}, ${f.other_discount}, ${f.other_charges},
              ${f.refunds}, ${f.cash_collected}, ${f.online_collected}, 'pos_v1_day_feed', ${feedId}, true, now(), ${row.createdBy},
              ${status === 'verified' ? row.createdBy : null}, ${status === 'verified' ? new Date().toISOString() : null})
      returning id`;
    await t`select set_config('app.sales_day_derivation', 'off', true)`;
    return { id: day!.id, feedId };
  };
  const begin = (tx as postgres.Sql).begin;
  return typeof begin === 'function' ? (tx as postgres.Sql).begin((t) => run(t)) as Promise<{ id: string; feedId: string }> : run(tx);
}
