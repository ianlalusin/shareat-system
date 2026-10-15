/**
 * The only place SQL is written for stores. T-152.
 *
 * ⚠️ **Small on purpose.** Store *identity* is read through Drizzle in the app helpers today; what
 * lives here is the **cash-custody policy** (bible row 129), because it is a money control and
 * changing it changes how much cash may sit in a drawer.
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Money } from '@shareat/core/money';
import type { Executor, Tx } from '../client';
import { stores, type RemittanceCadence, type StockModel } from '../../schema/stores';
import { MANILA_TODAY } from './sql-time';
import type { SafeInsert, SafeUpdate } from './numeric-input';

/**
 * T-371 C2 — the store row a writer may send: every numeric column a `Decimal` brand of its OWN shape. `SafeInsert`
 * alone says only "branded"; the ceiling is narrowed to `Money` (14,2), the column's shape.
 */
type StoreInsert = Omit<SafeInsert<typeof stores>, 'unremittedCeiling'> & { unremittedCeiling?: Money | null };
type StoreUpdate = Omit<SafeUpdate<typeof stores>, 'unremittedCeiling'> & { unremittedCeiling?: Money | null };

export interface StoreCashPolicy {
  storeId: string;
  name: string;
  remittanceCadence: RemittanceCadence;
  /** ⚠️ Null only while the cadence is `daily` — the database refuses it otherwise. */
  unremittedCeiling: string | null;
}

export async function cashPolicy(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<StoreCashPolicy | null> {
  const [row] = await tx
    .select({
      storeId: stores.id,
      name: stores.name,
      remittanceCadence: stores.remittanceCadence,
      unremittedCeiling: stores.unremittedCeiling,
    })
    .from(stores)
    .where(and(eq(stores.orgId, orgId), eq(stores.id, storeId)))
    .limit(1);
  return row ?? null;
}

/**
 * ⛔ **The database, not this function, is what makes the unsafe combination impossible.**
 *
 * `stores_pooling_requires_ceiling_check` refuses a non-daily cadence with no ceiling, so there is
 * deliberately **no second copy of that rule here** — bible §6.3: a rule re-implemented in
 * TypeScript is a second source of truth, and the two drift.
 *
 * ⚠️ Clearing the ceiling is expressed by passing `null`, which is only accepted alongside `daily`.
 */
export async function setCashPolicy(
  tx: Tx,
  orgId: string,
  input: { storeId: string; remittanceCadence: RemittanceCadence; unremittedCeiling: Money | null },
): Promise<void> {
  // T-371 C2 — the ceiling is a parsed `Money` (or null), never a raw string.
  const set: StoreUpdate = {
    remittanceCadence: input.remittanceCadence,
    unremittedCeiling: input.unremittedCeiling,
    updatedAt: new Date(),
  };
  await tx
    .update(stores)
    .set(set)
    .where(and(eq(stores.orgId, orgId), eq(stores.id, input.storeId)));
}

/**
 * T-204 — resolves a batch of store ids to their orgs, for the Firestore inbox relay: an event
 * carries a `storeId`, never an `orgId` (bible §5.1's own inbox shape), so `inbox_relay` needs a
 * `system`-principal cross-org lookup BEFORE it can open any org-scoped transaction. A storeId
 * absent from the returned map means no known store matches it — the caller leaves that event
 * un-stamped and excluded, per T-204 Contract §3 step 3.
 *
 * ⚠️ Deliberately no orgId filter — this runs as `system` (RLS bypassed by design, same as
 * `schedulerRepo.listOrgsToRun`) precisely because it must see every org's stores in one query.
 */
export async function orgIdsForStoreIds(
  tx: Tx,
  storeIds: readonly string[],
): Promise<Map<string, string>> {
  if (storeIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: stores.id, orgId: stores.orgId })
    .from(stores)
    .where(inArray(stores.id, [...storeIds]));
  return new Map(rows.map((r) => [r.id, r.orgId]));
}

// -----------------------------------------------------------------------------------------
// T-222 — store creation and management. ⛔ The SQL only; every rule lives in the database or
// the service. Note there is deliberately no `deleteStore`: a store accumulates journal
// entries, attendance and stock, so it is deactivated and never deleted (T-160's precedent
// for rooms, and v1's admin-only DELETE has no v2 counterpart).
// -----------------------------------------------------------------------------------------

export interface StoreRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly isActive: boolean;
  readonly stockModel: string;
  readonly remittanceCadence: string;
  /** ⚠️ Decimal string or null — null is legal ONLY with a daily cadence, and the database is
   *  what enforces that pairing (`stores_pooling_requires_ceiling_check`). */
  readonly unremittedCeiling: string | null;
  /** ⭐ T-229 slice 4 / DEF-208 — branch-level identity. The registered name, TIN and tax type
   *  belong to the ORGANISATION; a branch carries only its code against that TIN. */
  readonly tinBranchCode: string | null;
  readonly address: string | null;
  readonly contactNumber: string | null;
  /** ⭐ T-346 S1 (DEF-428). `null` = not yet open; a future date = planned. */
  readonly openingDate: string | null;
}

const STORE_COLUMNS = {
  id: stores.id,
  code: stores.code,
  name: stores.name,
  timezone: stores.timezone,
  isActive: stores.isActive,
  stockModel: stores.stockModel,
  remittanceCadence: stores.remittanceCadence,
  unremittedCeiling: stores.unremittedCeiling,
  tinBranchCode: stores.tinBranchCode,
  address: stores.address,
  contactNumber: stores.contactNumber,
  openingDate: stores.openingDate,
} as const;

/** Every store in the org, active first then by code — the `/admin/stores` list. */
export async function listForOrg(tx: Tx, orgId: string): Promise<StoreRow[]> {
  return tx
    .select(STORE_COLUMNS)
    .from(stores)
    .where(eq(stores.orgId, orgId))
    .orderBy(desc(stores.isActive), asc(stores.code)) as unknown as Promise<StoreRow[]>;
}

/**
 * T-346 S3 (DEF-428), §3.5 — `openingDate` per store, for `reports/store-comparison.ts`'s column
 * header. `Executor`, not `Tx` — a report reads through whichever the caller already has open
 * (`reportsRepo`'s own convention), never opens its own.
 */
export async function openingDatesByStore(
  ex: Executor,
  orgId: string,
  storeIds: string[],
): Promise<Map<string, string | null>> {
  if (storeIds.length === 0) return new Map();
  const rows = await ex
    .select({ id: stores.id, openingDate: stores.openingDate })
    .from(stores)
    .where(and(eq(stores.orgId, orgId), inArray(stores.id, storeIds)));
  return new Map(rows.map((r) => [r.id, r.openingDate]));
}

/** ⚠️ Scoped by org as well as id — an id from another tenant must read as absent, not as a row. */
export async function getById(tx: Tx, orgId: string, id: string): Promise<StoreRow | undefined> {
  const [row] = await tx
    .select(STORE_COLUMNS)
    .from(stores)
    .where(and(eq(stores.orgId, orgId), eq(stores.id, id)))
    .limit(1);
  return row as StoreRow | undefined;
}

export interface InsertStoreInput {
  readonly orgId: string;
  readonly code: string;
  readonly name: string;
  readonly timezone?: string;
  readonly stockModel?: 'single_room' | 'multi_room';
  readonly remittanceCadence?: string;
  /** T-371 C2 — parsed through `decimal()` upstream; absent leaves the column alone, `null` stores null. */
  readonly unremittedCeiling?: Money | null;
  /** T-346 S1. Absent or `null` both mean "not yet open". */
  readonly openingDate?: string | null;
}

export async function insertStore(tx: Tx, input: InsertStoreInput): Promise<{ id: string }> {
  // T-371 C2 — a typed row, no spreads: an absent optional key is left off so its column default applies.
  const values: StoreInsert = { orgId: input.orgId, code: input.code, name: input.name };
  if (input.timezone) values.timezone = input.timezone;
  if (input.stockModel) values.stockModel = input.stockModel;
  // ⚠️ Not a numeric column: an unknown cadence is refused by `stores_remittance_cadence_check`.
  if (input.remittanceCadence) values.remittanceCadence = input.remittanceCadence as RemittanceCadence;
  if (input.unremittedCeiling !== undefined) values.unremittedCeiling = input.unremittedCeiling;
  if (input.openingDate !== undefined) values.openingDate = input.openingDate;
  const [row] = await tx.insert(stores).values(values).returning({ id: stores.id });
  return row!;
}

export interface UpdateStorePatch {
  readonly name?: string;
  readonly timezone?: string;
  /** ⭐ T-229 slice 4 / DEF-208. `null` clears; an absent key leaves the column alone. */
  readonly address?: string | null;
  readonly contactNumber?: string | null;
  readonly tinBranchCode?: string | null;
  /** T-346 S1. Written only by `setStoreOpeningDate`, which carries the "has traded" refusal — this
   *  patch has no business rule of its own, same posture as `address`/`contactNumber`. */
  readonly openingDate?: string | null;
  /**
   * ⭐ T-284 / DEF-316. The column has existed since migration `0062` and had no writer of any
   * kind until now — every store has been `single_room`, the default, with no path off it.
   *
   * ⛔ **Never patch this through a general store-details save.** It is an INVARIANT, not a
   * preference: `setStoreStockModel` in the domain runs the room-count pre-flight that the
   * database does not have on this side (DEF-316), and reaching the column any other way skips
   * it. `updateStoreDetails` deliberately does not forward this key.
   */
  readonly stockModel?: StockModel;
}

/**
 * ⛔ `code` is deliberately NOT patchable. Ian, T-222 open question 1: rename freely, but the code
 * is the stable handle — it is user-facing, appears on documents, and other records refer to it.
 */
export async function updateStore(tx: Tx, orgId: string, id: string, patch: UpdateStorePatch): Promise<void> {
  await tx
    .update(stores)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(stores.orgId, orgId), eq(stores.id, id)));
}

/**
 * ⭐ T-229 slice 3. The store's Monitor WITH the person's name — the screen needs to show who it
 * is, not a uuid, and `/wastage` needs to name them when it explains where a loss will land.
 */
export async function wastageMonitorWithName(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<{ personId: string; displayName: string; isActive: boolean } | null> {
  const [row] = (await tx.execute(sql`
    select p.id, p.display_name, p.is_active
      from stores s join persons p on p.id = s.wastage_monitor_person_id
     where s.org_id = ${orgId} and s.id = ${storeId}
  `)) as unknown as Record<string, unknown>[];
  if (!row) return null;
  return {
    personId: String(row.id),
    displayName: String(row.display_name),
    isActive: Boolean(row.is_active),
  };
}

/**
 * ⭐ T-229 slice 3 (DEF-206) — the first writer this column has ever had outside a test's raw
 * `UPDATE`. `null` CLEARS it, and that is a real value: the schema calls an unassigned Monitor
 * *"the last rung of the backstop's own fallback order"*, so a Monitor who leaves must be
 * removable. ⛔ No business rule here — who may be Monitor is `stores/service.ts`'s call.
 */
export async function setWastageMonitor(
  tx: Tx,
  orgId: string,
  storeId: string,
  personId: string | null,
): Promise<void> {
  await tx
    .update(stores)
    .set({ wastageMonitorPersonId: personId, updatedAt: sql`now()` })
    .where(and(eq(stores.orgId, orgId), eq(stores.id, storeId)));
}

export async function setActive(tx: Tx, orgId: string, id: string, isActive: boolean): Promise<void> {
  await tx
    .update(stores)
    .set({ isActive, updatedAt: sql`now()` })
    .where(and(eq(stores.orgId, orgId), eq(stores.id, id)));
}

/**
 * ⭐ T-222 readiness input. Sales channels configured for this store — a **manual** check, because
 * which channels a branch sells through is a business fact and a default there would be, in v1's own
 * words, "a guess wearing the costume of a decision".
 */
export async function countSalesChannels(tx: Tx, orgId: string, storeId: string): Promise<number> {
  const [row] = (await tx.execute(sql`
    select count(*)::int as n from sales_channels
    where org_id = ${orgId} and store_id = ${storeId} and is_active = true
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}

/**
 * ⭐ T-222 readiness input, and the sharpest one (spec §5): **how many people can actually sign in
 * at this store?**
 *
 * ⛔ **T-302 rewrote the question, because the old one became wrong in the BLOCKING direction.**
 * This counted `person_credentials where store_id = <this store>`. That was right while a PIN
 * belonged to a (person, store) pair. It is not right now: a PIN row still carries one `store_id`
 * — where it was **issued** — while the credential itself works at every branch the person works
 * at. So a brand-new store would count **0** and the `signIn` readiness gate would block it as
 * *"No one can sign in here yet"* while every scoped or employed person could already sign in, and
 * its remedy would tell an admin to issue a PIN that is not needed. ⚠️ **A blocking gate that is
 * confidently wrong is worse than one that is merely stale** — it stops a real branch opening.
 *
 * **The question now is the sign-in gate's own question**, asked of the whole store rather than one
 * person: is there anybody with a live PIN who either works here or is scoped here? Kept as ONE
 * statement so it cannot drift from `accessRepo.personMaySignInAtStore`, which it must agree with —
 * the two are the same predicate at different cardinalities, and a readiness check that disagrees
 * with the gate it predicts is worse than no readiness check.
 *
 * ⛔ Store creation does NOT auto-issue a credential: that is a security decision, and a
 * generated-and-displayed default PIN is the kind of convenience that ends up in a screenshot.
 */
export async function countActiveCredentials(tx: Tx, storeId: string): Promise<number> {
  const [row] = (await tx.execute(sql`
    select count(distinct c.person_id)::int as n
    from person_credentials c
    join persons p on p.id = c.person_id
    where c.kind = 'pin'
      and c.revoked_at is null
      and (
        exists (
          select 1 from person_store_scope pss
          where pss.person_id = c.person_id and pss.store_id = ${storeId}
        )
        or exists (
          select 1 from employments e
          where e.person_id = c.person_id and e.store_id = ${storeId} and e.ended_on is null
        )
      )
      -- T-407 R2 lockstep: the same org-level rule R1 that personMaySignInAtStore applies (see personMaySignInToOrg).
      and (
        exists (
          select 1 from employments e2
          where e2.person_id = p.id and e2.org_id = p.org_id and e2.ended_on is null
        )
        or exists (
          select 1 from person_roles r
          where r.person_id = p.id and r.org_id = p.org_id and r.revoked_at is null and r.role in ('admin', 'super_admin')
        )
        or (
          exists (
            select 1 from person_roles r
            where r.person_id = p.id and r.org_id = p.org_id and r.revoked_at is null and r.role = 'manager'
          )
          and not exists (
            select 1 from employments e3 where e3.person_id = p.id and e3.org_id = p.org_id
          )
        )
      )
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}

// -----------------------------------------------------------------------------------------
// T-346 S1 (DEF-428) — the store's opening date.
// -----------------------------------------------------------------------------------------

/**
 * ⭐ The one definition of "has this store traded" — reads the SQL function migration 0162
 * defines (`store_first_trading_date`), so the migration's one-time backfill and this live check
 * can never quietly disagree. `null` means the store has not traded yet.
 */
export async function firstTradingDate(tx: Tx, storeId: string): Promise<string | null> {
  const [row] = (await tx.execute(
    sql`select store_first_trading_date(${storeId}) as first_trading_date`,
  )) as unknown as { first_trading_date: string | null }[];
  return row?.first_trading_date ?? null;
}

/**
 * ⭐ One definition (DEF-283) — this is the TS twin; the SQL fragment lands with S3 where its
 * readers are (Amendment R2 item 3). A store with no opening date, or one still in the future,
 * has not opened yet.
 *
 * ⚠️ Only meaningful once `openingDate` has passed `isValidDateString` — `'2026-3-1'` sorts before
 * `'2026-03-01'` as a bare string, which is exactly the mis-comparison Amendment R3.1 found.
 */
export function isPreOpening(openingDate: string | null, today: string): boolean {
  return openingDate === null || openingDate > today;
}

/**
 * ⭐ The SQL twin of `isPreOpening`, above — landing NOW (Amendment R2 item 3) that its readers
 * exist (§3.5): `tillFloatOffTarget` (against today) and `openingDateContradicted` (against a
 * store's own first-trading date). Nest a raw column/expression fragment for both arguments —
 * `sql\`st.opening_date\`` for `openingDate`, and either the default (today) or another `sql`
 * fragment (e.g. `store_first_trading_date(st.id)`) for `asOf` — so a caller composing a larger raw
 * query never re-derives this comparison inline.
 */
export function isPreOpeningSql(openingDate: SQL, asOf: SQL = MANILA_TODAY): SQL {
  return sql`(${openingDate} IS NULL OR ${openingDate} > ${asOf})`;
}

/**
 * ⭐ Amendment R3.1 — a real `YYYY-MM-DD` calendar date, not merely shaped like one. Every
 * date-vs-date comparison in this feature (`isPreOpening`, the "has traded" check, the backfill
 * itself) is a plain STRING comparison, which is only safe once this is true: `'01/01/2099'` is not
 * a date at all, and `'2026-3-1'` — valid, unpadded — sorts BEFORE `'2026-03-01'` as a string
 * despite naming a LATER day. One definition, called everywhere a caller-supplied date reaches a
 * comparison, so no call site re-derives its own (and possibly looser) check.
 */
export function isValidDateString(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
