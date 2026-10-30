/**
 * T-398 S7b - onboard a franchise company (Padre Garcia): steps 1-7 of docs/tasks/398-s7/S7-REFRESH.md s5, in ONE owner transaction.
 *
 * ## Why this opens its own transaction (and so lives in its own file)
 * A franchisee's company does not exist yet, so no request principal can write it: this is the same shape as `bootstrapOrganization`'s callers
 * (bible row 185), a one-shot run by a person at a terminal (`scripts/onboard-franchise.ts`), never reachable from a request. `organizations/index.ts`
 * itself never calls `systemTransaction` (a guard pins that), so the opener is here and index.ts only re-exports it.
 *
 * ## What it does, in order, all or nothing
 *  1. Refuses a `--by` person who is not a super-admin-capability holder of the franchisor company, an unknown franchisor, and a company code that
 *     exists under a different name. A company that exists with the same name and already has its agreement is "already-onboarded": nothing is written.
 *  2. `createOrganization` (chart, categories, periods, the six canonical positions).
 *  3. Ian's person in the new company: `createFirstAdmin` with the name in parts, plus his email as an identity.
 *  4. The store and its default room (`createStore`, which also scopes that admin to it).
 *  5. The owner: a person with the `manager` role and NO employment row (row 340), scoped to the new store, email as an identity.
 *  6. Staff: a person and an employment each at the new store; the staff code is issued by the generator, the position comes from the file.
 *  7. The `franchise_agreements` row (written here as owner: the app role cannot).
 *
 *  8-10. (A SECOND transaction, so a failure there leaves PG's company and a re-run completes it.) Ian's side: the customer linked to the new company
 *     and its price list, one line per commissary-offered item at today's branch price (a snapshot: a re-run adds only missing lines and never moves a
 *     rate); PG's side: the commissary supplier linked to Ian's company, and a PG item (name, unit, kind; no cost, no price) for every price-list line,
 *     declared on that supplier. Every part looks before it writes, so a re-run does only what is missing.
 *
 * A dry run does the checks of step 1 (read-only) and returns the plan; it opens no write.
 */
import {
  accessRepo,
  apRepo,
  auditLogRepo,
  commissaryCatalogueRepo,
  customersRepo,
  employmentRepo,
  franchiseRepo,
  interEntityRepo,
  itemsRepo,
  organizationsRepo,
  personsRepo,
  systemTransaction,
  type Tx,
} from '@shareat/db';
import { can, SUPER_ADMIN_ONLY_CAPABILITIES, type Actor } from '@shareat/auth';
import { toBusinessDate } from '@shareat/core';
import { add, money, ZERO } from '@shareat/core/money';
import { createStore } from '../stores/service';
import { createEmployment, createPerson, normaliseName } from '../people';
import { refuse } from '../shared/refusal';
import { createCustomer } from '../customers';
import { createSupplier } from '../ap';
import { branchPriceFor, createItem, declareSupplierItem } from '../items';
import { createFirstAdmin, createOrganization } from './index';
import type { OnboardingFile } from './onboarding-file';

export interface OnboardFranchiseInput {
  readonly file: OnboardingFile;
  /** Ian's person in the franchisor company. Must hold the super-admin capabilities there. */
  readonly byPersonId: string;
}

export interface OnboardFranchiseResult {
  readonly status: 'created' | 'already-onboarded' | 'dry-run';
  readonly orgCode: string;
  /** What a run would do or did, one line each, for the CLI to print. */
  readonly plan: readonly string[];
  readonly orgId?: string;
  readonly storeId?: string;
  readonly adminPersonId?: string;
  readonly ownerPersonId?: string;
  readonly staffCount?: number;
}

function planFor(file: OnboardingFile): string[] {
  return [
    `company: ${file.org.name} (code ${file.org.code}), with its chart of accounts, expense categories, fiscal months and the six canonical positions`,
    `store: ${file.store.name} (code ${file.store.code}) and its default stock room`,
    `franchisor person: ${file.franchisorPerson.last}, ${file.franchisorPerson.first} (admin with the super-admin capabilities, scoped to the store)`,
    `owner: ${file.owner.last}, ${file.owner.first} (manager role, no employment record)`,
    `staff: ${file.staff.length} (${file.staff.map((s) => s.position).join(', ')}); staff codes are issued automatically`,
    `franchise agreement: ${file.org.name} is a franchisee of ${file.franchisorOrgCode}; sales visible from ${file.agreement.salesVisibleFrom}`,
  ];
}

interface PriceLine {
  itemId: string;
  name: string;
  baseUnit: string;
  kind: string;
  rate: string;
}

/** The items on the price list: every active commissary-offered item that has a price rule the branch price can answer. Read-only. */
async function priceLinesFor(tx: Tx, franchisorId: string): Promise<PriceLine[]> {
  const offered = await commissaryCatalogueRepo.listActiveOfferedItems(tx, franchisorId);
  const lines: PriceLine[] = [];
  for (const o of offered) {
    const price = await branchPriceFor(tx, franchisorId, o.itemId);
    if (price) lines.push({ ...o, rate: price.price });
  }
  return lines;
}

/**
 * DEF-803 (b): steps 8-10 as plan lines, so a dry run shows Ian's side too: the customer, the price list with its item count and the total it would
 * write (S7-REFRESH C5), PG's commissary supplier and how many items are mirrored to PG. Read-only: it only describes what completeBothSides would write.
 */
function ianSidePlanFor(file: OnboardingFile, lines: readonly PriceLine[]): string[] {
  const total = lines.reduce((sum, l) => add(sum, money(l.rate)), ZERO);
  return [
    `customer: ${file.commissary.customerName} (in ${file.franchisorOrgCode}, linked to ${file.org.name}, on the price list below)`,
    `price list: ${file.commissary.priceListName}: ${lines.length} items, total ${total} (today's branch prices, a snapshot)`,
    `supplier: ${file.commissary.supplierName} (in ${file.org.name}, linked to ${file.franchisorOrgCode})`,
    `items mirrored to the new company: ${lines.length}, each declared on that supplier (name, unit and kind only; no cost, no price)`,
  ];
}

export async function onboardFranchiseOrganization(
  input: OnboardFranchiseInput,
  options: { dryRun: boolean },
): Promise<OnboardFranchiseResult> {
  const { file, byPersonId } = input;
  const plan = planFor(file);

  const first = await systemTransaction(async (tx) => {
    // 1. Who is asking, and which company they act for.
    const franchisor = await organizationsRepo.getOrgByCode(tx, file.franchisorOrgCode);
    if (!franchisor) {
      throw refuse(
        'onboardFranchiseOrganization: franchisorOrgCode names no company.',
        'The franchisor company named in the file does not exist, so nothing was written.',
      );
    }
    const by: Actor = { personId: byPersonId, orgId: franchisor.id };
    for (const capability of SUPER_ADMIN_ONLY_CAPABILITIES) {
      if (!(await can(tx, by, capability, {}))) {
        throw refuse(
          'onboardFranchiseOrganization: the --by person lacks the super-admin capabilities in the franchisor company.',
          'The person named with --by must be an owner (super-admin) of the franchisor company, so nothing was written.',
        );
      }
    }

    // Idempotency: same code and same name with its agreement in place is a no-op; the same code under another name is refused.
    const existing = await organizationsRepo.getOrgByCode(tx, file.org.code);
    if (existing) {
      if (existing.name !== file.org.name) {
        throw refuse(
          `onboardFranchiseOrganization: a company with code "${file.org.code}" already exists under a different name.`,
          `A company with the code ${file.org.code} already exists under a different name. Codes are permanent, so nothing was written.`,
        );
      }
      const agreement = await franchiseRepo.getAgreement(tx, existing.id);
      if (agreement) {
        if (agreement.franchisorOrgId !== franchisor.id) {
          throw refuse(
            `onboardFranchiseOrganization: "${file.org.code}" already has an agreement with a different franchisor.`,
            `The company ${file.org.code} already has a franchise agreement with a different franchisor company than the one named in the file, so nothing was written.`,
          );
        }
        return { kind: 'existing' as const, franchisor, orgId: existing.id, adminPersonId: agreement.franchisorPersonId };
      }
      throw refuse(
        `onboardFranchiseOrganization: "${file.org.code}" exists but has no franchise agreement.`,
        `The company ${file.org.code} exists but is only partly set up. It needs a person to look at it; nothing was written.`,
      );
    }

    if (options.dryRun) return { kind: 'dry-run' as const, ianSide: ianSidePlanFor(file, await priceLinesFor(tx, franchisor.id)) };

    // 2. Company and reference data.
    const org = await createOrganization(tx, { code: file.org.code, name: file.org.name });

    // 3. Ian's person in the new company.
    const fp = normaliseName({ lastName: file.franchisorPerson.last, firstName: file.franchisorPerson.first, middleName: file.franchisorPerson.middle });
    const admin = await createFirstAdmin(tx, {
      orgId: org.orgId,
      name: { lastName: fp.lastName, firstName: fp.firstName, middleName: fp.middleName ?? null },
    });
    await personsRepo.insertEmailIdentity(tx, admin.personId, file.franchisorPerson.email);
    const adminActor: Actor = { personId: admin.personId, orgId: org.orgId };

    // 4. Store and room (scopes the admin to the store).
    const store = await createStore(tx, adminActor, { code: file.store.code, name: file.store.name });

    // 5. The owner: manager role, no employment, scoped to the one store.
    const ow = normaliseName({ lastName: file.owner.last, firstName: file.owner.first, middleName: file.owner.middle });
    const owner = await personsRepo.insertPerson(tx, {
      orgId: org.orgId,
      name: { lastName: ow.lastName, firstName: ow.firstName, middleName: ow.middleName ?? null },
    });
    await accessRepo.insertRole(tx, { personId: owner.id, orgId: org.orgId, role: 'manager', grantedBy: admin.personId });
    await accessRepo.grantStoreScope(tx, { personId: owner.id, storeId: store.storeId, grantedBy: admin.personId, source: 'manual' });
    await personsRepo.insertEmailIdentity(tx, owner.id, file.owner.email);

    // 6. Staff, in file order.
    const startedOn = toBusinessDate();
    for (const s of file.staff) {
      const position = await employmentRepo.findPositionByName(tx, org.orgId, null, s.position);
      if (!position) {
        throw refuse(
          `onboardFranchiseOrganization: canonical position "${s.position}" is missing.`,
          `The position ${s.position} is missing in the new company, so nothing was written.`,
        );
      }
      const person = await createPerson(tx, adminActor, {
        storeId: store.storeId,
        name: { lastName: s.last, firstName: s.first, middleName: s.middle },
      });
      await createEmployment(tx, adminActor, {
        storeId: store.storeId,
        personId: person.id,
        employmentStatus: 'probationary',
        startedOn,
        positionIds: [position.id],
        primaryPositionId: position.id,
      });
    }

    // 7. The agreement.
    await franchiseRepo.insertAgreement(tx, {
      franchiseeOrgId: org.orgId,
      franchisorOrgId: franchisor.id,
      franchisorPersonId: admin.personId,
      salesVisibleFrom: file.agreement.salesVisibleFrom,
    });

    // The act, on the franchisor's side (Ian's), after everything else so a failure above leaves no row.
    await auditLogRepo.append(tx, franchisor.id, {
      actorPersonId: byPersonId,
      action: 'onboard.franchise',
      storeId: null,
      entityId: org.orgId,
      before: null,
      after: { orgCode: file.org.code, orgName: file.org.name, storeCode: file.store.code, staffCount: file.staff.length, salesVisibleFrom: file.agreement.salesVisibleFrom },
      source: 'manual',
    });

    return { kind: 'created' as const, franchisor, orgId: org.orgId, storeId: store.storeId, adminPersonId: admin.personId, ownerPersonId: owner.id };
  });

  if (first.kind === 'dry-run') return { status: 'dry-run', orgCode: file.org.code, plan: [...plan, ...first.ianSide] };

  // Steps 8-10, in their own transaction.
  const both = {
    file,
    franchisor: { id: first.franchisor.id },
    pgOrgId: first.orgId,
    pgAdmin: { personId: first.adminPersonId, orgId: first.orgId },
    by: { personId: byPersonId, orgId: first.franchisor.id },
  };
  if (options.dryRun) {
    // DEF-804: an existing company's dry run must write nothing. Run the real steps to learn what a re-run would add, then roll the transaction back.
    const rollback = new Error('onboardFranchiseOrganization: dry-run rollback');
    let wouldWrite = false;
    let lines: PriceLine[] = [];
    try {
      await systemTransaction(async (tx) => {
        lines = await priceLinesFor(tx, first.franchisor.id);
        wouldWrite = await completeBothSides(tx, both);
        throw rollback;
      });
    } catch (e) {
      if (e !== rollback) throw e;
    }
    if (!wouldWrite) return { status: 'already-onboarded', orgCode: file.org.code, plan, orgId: first.orgId };
    return { status: 'dry-run', orgCode: file.org.code, plan: [...plan, ...ianSidePlanFor(file, lines)], orgId: first.orgId };
  }
  const wrote = await systemTransaction((tx) => completeBothSides(tx, both));

  if (first.kind === 'existing' && !wrote) return { status: 'already-onboarded', orgCode: file.org.code, plan, orgId: first.orgId };
  return {
    status: 'created',
    orgCode: file.org.code,
    plan,
    orgId: first.orgId,
    ...(first.kind === 'created'
      ? { storeId: first.storeId, adminPersonId: first.adminPersonId, ownerPersonId: first.ownerPersonId, staffCount: file.staff.length }
      : { adminPersonId: first.adminPersonId }),
  };
}

/** Steps 8-10. Returns true when it wrote anything. Every part reads before it writes, so a second run does only what is missing. */
async function completeBothSides(
  tx: Tx,
  c: { file: OnboardingFile; franchisor: { id: string }; pgOrgId: string; pgAdmin: Actor; by: Actor },
): Promise<boolean> {
  const { file } = c;
  let wrote = false;

  // The items on the price list: every active commissary-offered item that has a price rule the branch price can answer.
  const lines = await priceLinesFor(tx, c.franchisor.id);

  // Refuse a name that is already taken by something linked elsewhere, BEFORE any write on either side. Never re-point a link.
  const customers = await customersRepo.listCustomers(tx, c.franchisor.id);
  const sameCustomer = customers.find((cu) => cu.name.trim().toLowerCase() === file.commissary.customerName.trim().toLowerCase());
  if (sameCustomer && sameCustomer.counterpartyOrgId !== c.pgOrgId) {
    throw refuse(
      `onboardFranchiseOrganization: customer "${file.commissary.customerName}" exists but is not linked to the new company.`,
      `A customer named ${file.commissary.customerName} already exists but is not linked to this franchise company. A person has to settle it; nothing was written.`,
    );
  }
  const suppliers = await apRepo.listSuppliers(tx, c.pgOrgId, { includeInactive: true });
  const found = suppliers.find((sp) => sp.name.trim().toLowerCase() === file.commissary.supplierName.trim().toLowerCase());
  if (found && found.counterpartyOrgId !== null && found.counterpartyOrgId !== c.franchisor.id) {
    throw refuse(
      `onboardFranchiseOrganization: supplier "${file.commissary.supplierName}" is already linked to another company.`,
      `A supplier named ${file.commissary.supplierName} already exists in the new company and is linked to a different company. A person has to settle it; nothing was written.`,
    );
  }

  // 8. Ian's side: the price list, its lines, the customer.
  const lists = await customersRepo.listPriceLists(tx, c.franchisor.id, { includeRetired: true });
  let priceListId = lists.find((l) => l.name === file.commissary.priceListName)?.id;
  if (!priceListId) {
    priceListId = (await customersRepo.insertPriceList(tx, { orgId: c.franchisor.id, name: file.commissary.priceListName, description: null, createdBy: c.by.personId })).id;
    wrote = true;
  }
  const quoted = await customersRepo.quotedItemIds(tx, priceListId);
  for (const line of lines) {
    if (quoted.has(line.itemId)) continue;
    await customersRepo.upsertPriceListItem(tx, { orgId: c.franchisor.id, priceListId, itemId: line.itemId, rate: money(line.rate), unit: null });
    wrote = true;
  }
  if (!sameCustomer) {
    const created = await createCustomer(tx, c.by, {
      name: file.commissary.customerName,
      counterpartyOrgId: c.pgOrgId,
      priceListId,
      creditTermsDays: file.commissary.creditTermsDays,
    });
    if (file.commissary.creditLimit !== null) await customersRepo.setCreditLimit(tx, c.franchisor.id, created.id, money(file.commissary.creditLimit));
    wrote = true;
  }

  // 9. PG's side: the commissary supplier, then a PG item for every line, declared on it.
  let supplierId = found?.id;
  if (!supplierId) {
    supplierId = (await createSupplier(tx, c.pgAdmin, { name: file.commissary.supplierName })).id;
    wrote = true;
  }
  if (!found || found.counterpartyOrgId !== c.franchisor.id) {
    await apRepo.updateSupplier(tx, c.pgOrgId, supplierId, { counterpartyOrgId: c.franchisor.id });
    wrote = true;
  }

  const pgItemIds: string[] = [];
  for (const line of lines) {
    const hit = await itemsRepo.findItemByName(tx, c.pgOrgId, line.name);
    if (hit) {
      const row = await itemsRepo.getItemById(tx, c.pgOrgId, hit.id);
      if (hit.status !== 'active' || !row || row.baseUnit !== line.baseUnit) {
        throw refuse(
          `onboardFranchiseOrganization: the item "${line.name}" already exists in the new company but is not active or has another unit.`,
          `The item ${line.name} already exists in the new company but is retired or counted in a different unit than the commissary's. A person has to settle it; nothing more was written.`,
        );
      }
      pgItemIds.push(hit.id);
    } else {
      const made = await createItem(tx, c.pgAdmin, { name: line.name, kind: line.kind as never, baseUnit: line.baseUnit as never });
      pgItemIds.push(made.id);
      wrote = true;
    }
  }
  const declared = await interEntityRepo.declaredItemIds(tx, c.pgOrgId, supplierId, pgItemIds);
  for (const itemId of pgItemIds) {
    if (declared.has(itemId)) continue;
    await declareSupplierItem(tx, c.pgAdmin, { supplierId, itemId });
    wrote = true;
  }
  return wrote;
}
