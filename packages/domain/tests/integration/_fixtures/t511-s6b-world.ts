/**
 * T-511 S6b (TESTER) - the world the platform-sales-correction tests run in (NOT a test file). One org per call, real Postgres through the caller's connection.
 *
 * The world: Lipa (store A) with a Foodpanda channel (receivable 1220, platform 'foodpanda', a destination bank account), Malvar (store B), an admin scoped to
 * both, a manager of each, a submitter, the chart of accounts, and the periods Oct 2026 and Nov 2026 OPEN. A typed sales day on `DATE` carries a Foodpanda
 * amount of `staff` (created, submitted and verified through the real domain, so 1220 / 4150 is raised exactly as production raises it) and a staged
 * `settlement_day_lines` row carries the FILE figure `file` (written raw through stored_files + settlement_uploads, the way t511-s2-migration.test.ts does).
 */
import type postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSalesDay } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../db/seed/expense-categories';
import { mkSubmitter, submitThenVerify } from './sales-day-flow';

/** A Monday, inside October 2026. */
export const DATE = '2026-10-12';
/** The clock every test passes (`today`), so "the first open date" is deterministic. */
export const TODAY = '2026-11-05';
/** The first open date when October is closed and November is open. */
export const NEXT_OPEN = '2026-11-01';

let seq = 0;
export const uid = (p: string): string => `${p}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export interface RawLineOpts {
  orgId: string;
  storeId: string;
  channelId: string;
  platform: 'grab' | 'foodpanda';
  salesDate: string;
  /** The file figure (net of the platform discount, what staff record): the figure the correction moves the books to. */
  orderValue: string;
  personId: string;
  version?: number;
}

/** A current staged day line (and the stored file and upload it needs) written raw. A later `version` supersedes the earlier current one. */
export async function rawDayLine(sql: postgres.Sql, o: RawLineOpts): Promise<string> {
  const version = o.version ?? 1;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${o.orgId}, ${o.storeId}, 'memo_document', ${`orgs/${o.orgId}/stores/${o.storeId}/memo_document/${uid('f')}.pdf`}, 'application/pdf', 10, 'abc', ${o.personId}) returning id`;
  const [up] = await sql<{ id: string }[]>`
    insert into settlement_uploads (org_id, channel_id, store_id, platform, file_kind, file_id, fingerprint, reader_version, period_from, period_to, uploaded_by)
    values (${o.orgId}, ${o.channelId}, ${o.storeId}, ${o.platform}, ${o.platform === 'grab' ? 'grab_transactions' : 'foodpanda_invoice'}, ${file!.id}, ${uid('fp')}, '1', ${o.salesDate}, ${o.salesDate}, ${o.personId}) returning id`;
  if (version > 1) {
    await sql`update settlement_day_lines set is_current = false where org_id = ${o.orgId} and channel_id = ${o.channelId} and sales_date = ${o.salesDate} and is_current`;
  }
  const [line] = await sql<{ id: string }[]>`
    insert into settlement_day_lines (org_id, channel_id, store_id, platform, sales_date, version, is_current, source_upload_id, order_value, gross_info, commission, marketing, platform_fee,
                                      vendor_discount, loan_deduction, loan_disbursal, net_payout, unexplained, paid_state, review_state)
    values (${o.orgId}, ${o.channelId}, ${o.storeId}, ${o.platform}, ${o.salesDate}, ${version}, true, ${up!.id}, ${o.orderValue}, ${o.orderValue}, '0.00', '0.00', '0.00',
            '0.00', '0.00', '0.00', ${o.orderValue}, '0.00', 'paid', 'pending') returning id`;
  return line!.id;
}

export interface FxOpts {
  /** What staff typed for the Foodpanda channel on DATE. */
  staff: string;
  /** The file figure on the staged day line. */
  file: string;
  /** The channel's receivable account; default '1220'. */
  receivable?: string;
  /** false leaves the sales day OPEN (created, never submitted or verified). Default true. */
  verified?: boolean;
}

export async function fx(sql: postgres.Sql, hint: string, o: FxOpts) {
  const code = uid(`t511s6b-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-10-01', '2026-10-31', 'open'), (${orgId}, '2026-11-01', '2026-11-30', 'open')`;
  const store = async (name: string): Promise<string> =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${name}) returning id`)[0]!.id;
  const storeA = await store('Lipa');
  const storeB = await store('Malvar');
  const person = async (name: string, role: string, stores: string[]): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { personId: p!.id, orgId };
  };
  const admin = await person('Admin', 'admin', [storeA, storeB]);
  const managerA = await person('Manager A', 'manager', [storeA]);
  const managerB = await person('Manager B', 'manager', [storeB]);
  const submitter = await mkSubmitter(sql, orgId, [storeA], 'Submitter');
  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active) values (${orgId}, ${storeA}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, platform, platform_store_code, destination_money_account_id)
    values (${orgId}, ${storeA}, 'Foodpanda', false, ${o.receivable ?? '1220'}, 'foodpanda', ${uid('FP')}, ${bank!.id}) returning id`;
  const channelId = ch!.id;

  const { id: dayId } = await asOrg(orgId, (tx) =>
    createSalesDay(tx, submitter, {
      storeId: storeA, businessDate: DATE, totalSales: o.staff, unliSales: '0.00', alaCarteSales: o.staff, cashCollected: '0.00',
      channels: [{ channelId, amount: o.staff }],
    }),
  );
  if (o.verified !== false) await asOrg(orgId, (tx) => submitThenVerify(tx, admin, dayId, submitter));
  const lineId = await rawDayLine(sql, { orgId, storeId: storeA, channelId, platform: 'foodpanda', salesDate: DATE, orderValue: o.file, personId: admin.personId });
  return { orgId, storeA, storeB, channelId, bankId: bank!.id, dayId, lineId, admin, managerA, managerB, submitter, staff: o.staff, file: o.file };
}
export type Fx = Awaited<ReturnType<typeof fx>>;

/** The input every call passes unless a test overrides it. */
export const baseInput = (f: { lineId: string }, over: Record<string, unknown> = {}) => ({ dayLineId: f.lineId, reason: 'File is the truth', today: TODAY, ...over });

export interface CorrectResult {
  corrected: boolean;
  correctionId?: string;
  journalEntryId?: string;
}
interface CorrectionModule {
  correctPlatformSales: (tx: Tx, actor: Actor, input: Record<string, unknown>) => Promise<CorrectResult>;
  correctPlatformSalesOnClock: (tx: Tx, actor: Actor, input: Record<string, unknown>, today?: string) => Promise<CorrectResult>;
}
const loadModule = async (): Promise<CorrectionModule> => (await import('../../../src/channel-settlements/correction')) as unknown as CorrectionModule;
/** The function under test through the test seam (the clock is `over.today`, default TODAY), loaded lazily so only the legs that call it fail on a tree without it. */
export async function correct(f: { orgId: string; lineId: string }, who: Actor, over: Record<string, unknown> = {}): Promise<CorrectResult> {
  const m = await loadModule();
  const { today, ...input } = baseInput(f, over);
  return asOrg(f.orgId, (tx) => m.correctPlatformSalesOnClock(tx, who, input, today as string));
}
/** The PRODUCTION entry point; a `today` in `over` is smuggled in to prove it is ignored. */
export async function correctProd(f: { orgId: string; lineId: string }, who: Actor, over: Record<string, unknown> = {}): Promise<CorrectResult> {
  const m = await loadModule();
  return asOrg(f.orgId, (tx) => m.correctPlatformSales(tx, who, baseInput(f, over)));
}

/* ------------------------------------------------------------------ read-backs on the raw connection */

export interface CorrectionRow {
  id: string; org_id: string; store_id: string; sales_day_id: string; channel_id: string; day_line_id: string; from_amount: string; to_amount: string;
  entry_date: string; journal_entry_id: string; reason: string; posted_by: string;
}
export const corrections = (sql: postgres.Sql, orgId: string): Promise<CorrectionRow[]> => sql<CorrectionRow[]>`
  select id::text, org_id::text, store_id::text, sales_day_id::text, channel_id::text, day_line_id::text, from_amount::text, to_amount::text,
         to_char(entry_date, 'YYYY-MM-DD') as entry_date, journal_entry_id::text, reason, posted_by::text
    from sales_day_platform_corrections where org_id = ${orgId} order by posted_at, id`;

export interface LineRow { code: string; debit: string; credit: string; store_id: string | null; party_type: string | null; party_id: string | null }
export const linesOf = (sql: postgres.Sql, entryId: string): Promise<LineRow[]> => sql<LineRow[]>`
  select a.code, jl.debit::text, jl.credit::text, jl.store_id::text, jl.party_type, jl.party_id::text
    from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${entryId} order by jl.line_no`;
export const lineText = (rows: LineRow[]): string[] =>
  rows.map((l) => (Number(l.debit) > 0 ? `Dr ${l.code} ${l.debit}` : `Cr ${l.code} ${l.credit}`)).sort();

export interface EntryRow {
  id: string; source_type: string; source_id: string; status: string; reversal_of_entry_id: string | null; entry_date: string; idempotency_key: string | null;
}
export const entriesOf = (sql: postgres.Sql, orgId: string): Promise<EntryRow[]> => sql<EntryRow[]>`
  select id::text, source_type, source_id, status, reversal_of_entry_id::text, to_char(entry_date, 'YYYY-MM-DD') as entry_date, idempotency_key
    from journal_entries where org_id = ${orgId} order by created_at, id`;

/** Net debit minus credit of one account over every posted or reversed line of the org (a reversed entry and its reversal net to zero). */
export async function netDebit(sql: postgres.Sql, orgId: string, code: string): Promise<string> {
  const [r] = await sql<{ n: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2)::text as n
      from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
     where je.org_id = ${orgId} and je.status in ('posted', 'reversed') and a.code = ${code}`;
  return r!.n;
}

export const auditRows = (sql: postgres.Sql, orgId: string, action: string) => sql<{ action: string; entity_id: string; store_id: string | null; actor_person_id: string | null }[]>`
  select action, entity_id::text, store_id::text, actor_person_id::text from audit_log where org_id = ${orgId} and action = ${action} order by recorded_at`;

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The plain sentence of a refusal (`userMessage`), after asserting the call refused. */
export async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  if (!(err instanceof Error)) throw new Error('the call must refuse, but it succeeded');
  // a missing module or function is not a refusal: it must not satisfy a "refuses" test
  if (/Cannot find module|Failed to resolve import|is not a function/.test(err.message)) throw err;
  return String((err as { userMessage?: string }).userMessage ?? err.message);
}
