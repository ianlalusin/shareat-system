/**
 * The SC/PWD statutory register — RR 5-2017 §5.9 (PWD) and RR 7-2010 (senior).
 * `docs/tasks/137-statutory-discount-logbook.md`.
 *
 * ## ⛔ This module posts NOTHING, deliberately
 *
 * Bible row 75: *"a statutory basis, if ever needed, is a separate reporting layer over the same
 * ledger — not a retrofit of these accounts."* The daily `sales_days.senior_discount` /
 * `pwd_discount` totals are the only route to 4900, and they stay exactly as they are (row 132).
 * **The register is a parallel record, not a replacement**: one is for the books, the other is for
 * the BIR. `statutory-discounts.test.ts` invariant 8 asserts the ledger does not move.
 *
 * ## ⚠️ Two of the six fields cannot be derived, and that is the whole shape of this feature
 *
 * `holderName` and `idNumber` are read off a physical card by a person. **Nothing captures them
 * today** — not POS, not v1's ERP (DEF-101; the original spec claimed otherwise). POS already
 * writes the other four per transaction in its `DiscountEvent`, so the gap is two fields, not
 * five, and closing it needs POS v2 after January.
 *
 * ⛔ **And there is no paper logbook to fall back on.** Ian, 2026-08-29: *“they are not kept to
 * avail the discount they just present id and the pos picks the discount from the list of
 * configured discount.”* So the obligation is **unmet today, in every form** (bible row 164), and
 * this register is the first place it is met rather than the digitisation of an existing book.
 * ⚠️ **It therefore cannot be back-filled** — nothing downstream holds a name or an ID number, so
 * a row must be entered while the customer is still at the counter. That is why
 * `record_statutory_discount` is staff-open: the only person who can create one is the cashier.
 *
 * ## What is deliberately NOT validated here
 *
 * ⛔ **No discount RATE is enforced.** The headline is 20%, but RR 5-2017 also carries a 5%
 * special discount on basic necessities, and promotional pricing interacts with both. A hard 20%
 * rule would reject valid records — so the rate is recorded, never judged.
 *
 * ⛔ **No ID FORMAT is enforced.** OSCA and PWD IDs are LGU-issued and their formats vary by city;
 * a regex would refuse valid cards from the next municipality.
 *
 * ⚠️ **And no rule that the database already holds is re-checked here.** One live row per invoice,
 * positive amounts, a discount within its gross, an all-or-nothing void and a non-blank identity
 * are constraints in migration 0065. Restating them in TypeScript would be a second source of
 * truth, and the two would drift.
 */
import { authorize, type Actor } from '@shareat/auth';
import {
  accessRepo,
  statutoryDiscountsRepo,
  transaction,
  type StatutoryDiscountRow,
  type StatutoryDiscountSummary,
  type Tx,
} from '@shareat/db';

export interface RecordStatutoryDiscountInput {
  storeId: string;
  /** The date of the SALE, never of the data entry. */
  businessDate: string;
  invoiceNumber: string;
  kind: 'senior' | 'pwd';
  idNumber: string;
  holderName: string;
  grossAmount: string;
  discountAmount: string;
  /** Not reg text — RR 10-2015's signature is the CUSTOMER's, and RR 8-2023 waives it online. */
  signatory?: string | null;
  notes?: string | null;
}

export interface ListStatutoryDiscountsQuery {
  storeId?: string;
  from: string;
  to: string;
  includeVoided?: boolean;
}

export async function recordStatutoryDiscount(
  tx: Tx | null,
  actor: Actor,
  input: RecordStatutoryDiscountInput,
): Promise<{ id: string }> {
  if (tx) return runRecord(tx, actor, input);
  return transaction((trx) => runRecord(trx, actor, input));
}

async function runRecord(tx: Tx, actor: Actor, input: RecordStatutoryDiscountInput): Promise<{ id: string }> {
  await authorize(tx, actor, 'record_statutory_discount', { storeId: input.storeId });

  return statutoryDiscountsRepo.create(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    businessDate: input.businessDate,
    invoiceNumber: input.invoiceNumber.trim(),
    kind: input.kind,
    idNumber: input.idNumber.trim(),
    holderName: input.holderName.trim(),
    grossAmount: input.grossAmount,
    discountAmount: input.discountAmount,
    signatory: input.signatory?.trim() || null,
    // ⭐ Never accepted from the caller. Provenance is a fact about how the row was produced, and
    // this path is by definition the human one — a parameter would let a future caller claim
    // machine capture for a typed row, which is exactly the trust the column exists to carry.
    source: 'manual',
    notes: input.notes?.trim() || null,
    recordedBy: actor.personId,
  });
}

export interface VoidStatutoryDiscountInput {
  id: string;
  reason: string;
}

/**
 * ⛔ Withdrawing a statutory record is supervisory — `void_statutory_discount` is not staff-open,
 * and that asymmetry with recording IS the control (T-137, CAPABILITY-MATRIX).
 */
export async function voidStatutoryDiscount(
  tx: Tx | null,
  actor: Actor,
  input: VoidStatutoryDiscountInput,
): Promise<void> {
  if (tx) return runVoid(tx, actor, input);
  return transaction((trx) => runVoid(trx, actor, input));
}

async function runVoid(tx: Tx, actor: Actor, input: VoidStatutoryDiscountInput): Promise<void> {
  const existing = await statutoryDiscountsRepo.findById(tx, actor.orgId, input.id);
  if (!existing) {
    throw new Error(`voidStatutoryDiscount: no statutory discount record ${input.id} in this organization`);
  }

  // Authorized against the record's OWN store, read from the row rather than supplied by the
  // caller — bible §7.1, and `no-client-supplied-actor.test.ts`'s whole subject.
  await authorize(tx, actor, 'void_statutory_discount', { storeId: existing.storeId });

  const reason = input.reason.trim();
  if (!reason) {
    // Not a database rule: the CHECK only requires the three void columns to move together, and
    // a whitespace reason would satisfy it. An unexplained withdrawal is the thing an auditor
    // asks about, so it is refused here.
    throw new Error('voidStatutoryDiscount: a reason is required — an unexplained withdrawal is what an audit asks about');
  }

  const { voided } = await statutoryDiscountsRepo.voidRecord(tx, actor.orgId, input.id, {
    voidedBy: actor.personId,
    reason,
  });
  if (!voided) {
    throw new Error(`voidStatutoryDiscount: record ${input.id} is already voided`);
  }
}

export async function listStatutoryDiscounts(
  tx: Tx | null,
  actor: Actor,
  query: ListStatutoryDiscountsQuery,
): Promise<StatutoryDiscountRow[]> {
  if (tx) return runList(tx, actor, query);
  return transaction((trx) => runList(trx, actor, query));
}

async function runList(tx: Tx, actor: Actor, query: ListStatutoryDiscountsQuery): Promise<StatutoryDiscountRow[]> {
  const scoped = await authorizeRead(tx, actor, query);
  return statutoryDiscountsRepo.listForRange(tx, actor.orgId, scoped);
}

/**
 * ⭐ **Reading the register is reading customers' names and government ID numbers**, so it is
 * gated on the same capability that writes it rather than left open to any signed-in member.
 *
 * ⚠️ **And "all stores" is resolved, never left blank.** `authorize` throws for a store-scoped
 * capability with no `storeId`, so an unfiltered read would simply crash — but the deeper problem
 * is that an absent filter must not come to mean *every* store. RLS bounds the ORG; it does not
 * bound the store, and a manager scoped to one branch must not read another branch's customers by
 * clearing a dropdown. So the caller's own `person_store_scope` rows become the filter.
 */
async function authorizeRead(tx: Tx, actor: Actor, query: ListStatutoryDiscountsQuery) {
  if (query.storeId) {
    await authorize(tx, actor, 'record_statutory_discount', { storeId: query.storeId });
    return query;
  }

  const storeIds = await accessRepo.storeIdsForPerson(tx, actor.personId);
  if (storeIds.length === 0) {
    // No scope is NOT "everything" — an unconfigured person is authorized for nothing
    // (bible §7.3, the same rule authorize() applies to a person with no active role).
    return { ...query, storeIds: [] as string[] };
  }
  // Every store in the sweep is authorized individually, so the capability and the store axis are
  // both checked for each one rather than being assumed from the first.
  for (const storeId of storeIds) {
    await authorize(tx, actor, 'record_statutory_discount', { storeId });
  }
  return { ...query, storeIds };
}

export async function summariseStatutoryDiscounts(
  tx: Tx | null,
  actor: Actor,
  query: ListStatutoryDiscountsQuery,
): Promise<StatutoryDiscountSummary> {
  const run = async (trx: Tx) => {
    const scoped = await authorizeRead(trx, actor, query);
    return statutoryDiscountsRepo.summaryForRange(trx, actor.orgId, scoped);
  };
  if (tx) return run(tx);
  return transaction(run);
}
