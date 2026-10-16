/**
 * T-227 — **a domain function that authorizes presumes a human, and nothing was checking that a
 * human could reach it.**
 *
 * `docs/tasks/227-caller-and-nav-guards.md`. Seven times now this project has shipped a service
 * that is written, gated, tested and callable by nobody: DEF-082, DEF-099, DEF-133, DEF-137,
 * DEF-157, DEF-174, DEF-186 — and then DEF-190, where `1210 Accounts receivable` turned out to have
 * a raising path, a reporting path and **no clearing path a human can reach.** Every one passed the
 * suite, because a function with a test and no caller passes its test.
 *
 * ## Why the population is `(tx, …, actor: Actor, …)` and not "every export"
 *
 * There are ~400 exports under `packages/domain/src` and ~157 have no `apps/` caller. **Reporting
 * 157 is reporting noise** — `compareQuantity` is arithmetic, `postEntry` is plumbing, and
 * `commitCountSession` only looks uncalled because `/inventory/counts` calls a wrapper named
 * `commitCount`. A guard that fires 157 times fires zero times.
 *
 * The repo's own layering already draws the line (bible §4.3; §13 row 138 — *"it always took
 * `(tx, actor, …)` and never asked where the actor came from"*). An `actor` parameter means the
 * function **authorizes**, and a function that authorizes is a user-initiated act. 214 exports are
 * shaped that way; 30 had no `apps/` caller when this guard was written. That is a list a person
 * can read, which is the whole difference between a guard and a wall of text.
 *
 * ⚠️ **Stated limit:** a state-moving function with no `actor` is out of this guard's population.
 * Those are either called by one that does take an actor, or are scheduler entry points with their
 * own registration guard. If a defect ever escapes through that gap, widen the rule here and say so.
 *
 * ## The exemption list is a confession, not a config knob
 *
 * Two rules, both enforced below: an uncalled action with no entry fails, **and an entry whose
 * export now HAS a caller also fails** — that row must be deleted. The second is what stops the list
 * calcifying, and it is the pattern `tests/unit/no-client-supplied-actor.test.ts` already uses.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appProductionSource, codeOnly, isCalledInSource, trackedFiles } from './lib/document-facts';

const repoRoot = path.resolve(__dirname, '../..');
const DOMAIN_ROOT = 'packages/domain/src/';

// ⛔ T-317: `trackedFiles`, `codeOnly` and `appProductionSource` moved to `./lib/document-facts` so
// guard 1's `STALE-IF-REACHABLE` marker can reuse this exact reachability resolution instead of
// writing a second one (invariant 6). Behaviour unchanged — same git command, same comment
// stripping, same `apps/**` filter; only the definitions relocated. `read`/`isTest` stay here:
// `actionShapedExports` below is specific to this guard's domain-export population, not to
// reachability itself.

const read = (repoRelative: string) => codeOnly(readFileSync(path.join(repoRoot, repoRelative), 'utf8'));
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.includes('/tests/');

/** The parameter list, by balancing parentheses — a regex cannot survive a nested generic. */
function paramsFrom(src: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(openParenIndex + 1, i);
  }
  return '';
}

/** name → declaring file, for every export shaped `(tx: Tx…, …, actor: Actor, …)`. */
function actionShapedExports(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of trackedFiles()) {
    if (!file.startsWith(DOMAIN_ROOT) || !file.endsWith('.ts') || isTest(file)) continue;
    const src = read(file);
    for (const m of src.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/gm)) {
      const params = paramsFrom(src, m.index! + m[0].length - 1);
      if (!/^_?(tx|trx)\s*:/.test(params.split(',')[0]?.trim() ?? '')) continue;
      if (!/(^|,)\s*_?actor\s*:\s*Actor\b/.test(params)) continue;
      if (!found.has(m[1]!)) found.set(m[1]!, file);
    }
  }
  return found;
}

/**
 * ⛔ **Every reason must say which of four things it is, and name the other half:**
 *
 *   1. *internal* — another domain function calls it; **name that function and its file**.
 *   2. *wrapper*  — an app action calls it under a different name; **name the wrapper**.
 *   3. *job*      — a scheduler, cron or script calls it; **name the job**.
 *   4. *unwired*  — nothing calls it and that is a gap; **cite the task or defect that owns it**.
 *
 * ⚠️ Kind 4 is not an excuse, it is a register. Thirty entries were written here on 2026-09-06 and
 * twenty-two were kind 4 — the measured size of the "built, tested, unreachable" debt, stated once
 * so it can be paid down and counted rather than rediscovered a screen at a time. **Four were paid
 * off the same day** by T-226, and the stale-exemption rule below is what forced their rows out.
 */
const EXEMPT: Record<string, string> = {
  revokePosTerminalLink:
    'UNWIRED — T-424 audit: scripts/provision-terminal.ts (--revoke-pos-device) is its caller, run by an administrator; no ERP screen yet. ' +
    'It retires a lost or replaced POS v2 tablet.',
  provisionPosTerminalLink:
    'UNWIRED — T-424 S5: scripts/provision-terminal.ts (--link-pos-device) is its caller, run by an administrator; no ERP screen yet. ' +
    "The tablet's device id is read from POS v2 Settings and typed into that command.",
  recordRemittanceEvent:
    'INTERNAL — `createRemittance` calls it (`remittance/index.ts:422`) in the same transaction, after its own rows (T-402 S3 C4); ' +
    'a separate file only so the action-coverage scan does not read the TYPE members in index.ts as audit actions.',
  runDualRun:
    'UNWIRED — T-392 S4: scripts/dual-run.ts `compare` is its caller (a job, run on the droplet); the on-screen report and disposition action are T-392 S5',
  setCustomerStatus:
    'UNWIRED — T-391 S4: scripts/master-data.ts apply (applyCustomers / applySuppliers) is its caller; no screen in S4',
  setSupplierCounterpartyStore:
    'UNWIRED — T-391 S4: scripts/master-data.ts apply (applyCustomers / applySuppliers) is its caller; no screen in S4',
  setItemPurchaseUnit:
    'UNWIRED — T-391 S3 item apply is its caller (the master-data load script); there is no screen for the buying unit yet, ' +
    'and the load is the only writer planned.',
  // ---- 1. internal: called by another domain function that is itself wired -------------------
  recordCharge:
    'INTERNAL — `dispatchTradeOrder` calls it (`trade/index.ts:460`); dispatch IS the billing ' +
    'event. ⚠️ The LAST of DEF-190’s five still without a screen: a charge raised outside a trade ' +
    'order is T-226 §6, and it is blocked on Ian deciding which revenue account a manual credit ' +
    'sale credits — no wholesale-revenue account exists in the chart.',
  writeToleranceVerified:
    'INTERNAL — `postUsage` calls it (`stock/usage-records.ts:298`) in the same transaction to record the manager’s reason for an out-of-band line.',
  capitalizeApprovedExpense:
    'INTERNAL — `approveExpense` calls it for a CAPEX category (`expenses/approve.ts:231`). It is ' +
    'deliberately not a human boundary: the caller is approving an expense, not managing assets.',
  retireAssetFromVoidedExpense:
    'INTERNAL — `voidExpense` calls it (`expenses/void.ts:68`) so voiding the expense retires the ' +
    'asset it created, in the same transaction.',
  writeChannels:
    'INTERNAL — `createSalesDay` calls it (`sales-days/create.ts:206`) to write the per-channel ' +
    'rows a sales day owns. Exported for its types, not as an entry point.',
  authorizeOtherStores:
    'INTERNAL — `voidCollection` (`ar/index.ts`), `reverseLoanEntry` (`loans/index.ts`) and `runVoidExpense` ' +
    '(`expenses/void.ts`) call it (T-369 S9 addendum A1, DEF-573) so undoing a cross-store posting needs ' +
    '`transfer_funds` at every other store the original touched. A gate inside the void, not a human boundary of its own.',
  prepareTransfer:
    'INTERNAL — `createMoneyTransfer` (`money-transfers/index.ts`) and `settleBetweenStores` ' +
    '(`money-transfers/settle.ts`) call it (T-369 S9, DEF-557): the shared half of a transfer (ends, office-only ' +
    'rule, both authorizes, amounts, draw check, fee and cash legs). Not a screen entry point.',
  writeTenders:
    'INTERNAL — `createSalesDay` and `editSalesDay` call it (`sales-days/create.ts`, `sales-days/edit.ts`) ' +
    'to write the per-wallet tender rows a sales day owns. Exported (T-369 S3) so the edit path shares the ' +
    'same validation, not as an entry point.',

  canBypassBlock:
    'INTERNAL — `assertCanOpenDay` calls it (`sales-days/create-block.ts:124`) to decide whether an actor skips the ' +
    'create-block; re-exported from `sales-days/create.ts`. A gate inside the create/import paths, not a human boundary.',
  assertCanOpenDay:
    'INTERNAL — `createSalesDay` (`sales-days/create.ts:101`) and `importSalesDay` (`sales-days/import.ts:123`, `:155`) ' +
    'call it: the create-block moved out of create.ts (T-375 S3) so both paths share it. Not a screen entry point.',
  assertStoreTakesTypedDays:
    'INTERNAL — `createSalesDay` (`sales-days/create.ts:87`) and `editSalesDay` (`sales-days/edit.ts:45`) call it (T-375 S3, R13) ' +
    'to refuse typed figures on a store linked to POS. A gate inside those two, not a human boundary of its own.',

  // ---- 4. unwired: nothing calls it, and that is the gap -------------------------------------
  //
  // ⭐ Four rows lived here for exactly one commit. `voidCollection`, `writeOffCharge`,
  // `recordCollection` and `voidCharge` were DEF-190's unreachable half; T-226 gave them
  // `/customers/[customerId]` and this test failed until the rows were deleted — which is the
  // stale-exemption rule doing its whole job, on the very next task after the guard shipped.
  reconcileSupplier:
    'UNWIRED — DEF-198. Its mirror `reconcileCustomer` IS wired; the supplier side of the same ' +
    'attestation is not, so `/ap/suppliers/[id]` cannot stamp a reconciliation anchor.',
  adjudicateRange:
    'UNWIRED — DEF-198. ⚠️ Its own doc says *"used by the review screen and the sweep"* and ' +
    'neither calls it. Attendance belongs to another session; reported, not touched (RULES §3.4a).',
  findPostedSettlementForChannelDay:
    'UNWIRED — DEF-198. `/channel-settlements` previews and records; nothing re-reads a POSTED ' +
    'settlement, so a settled channel-day cannot be reopened for inspection.',
  capitalizeFromExpense:
    'UNWIRED — DEF-198. Superseded in practice by `capitalizeApprovedExpense`, which ' +
    '`approveExpense` calls. Either give it a caller or retire it; two entry points to one act is ' +
    'how a rule comes to have two answers.',
  depreciateAsset:
    'UNWIRED — DEF-198. `/fixed-assets` runs `runDepreciation` org-wide; a single asset cannot be ' +
    'caught up on its own. ⚠️ `apps/erp/src/app/fixed-assets/actions.ts`’s own header claims ' +
    'to call `depreciateAsset` — a stale comment, corrected by this row rather than by editing an ' +
    'area this task does not own.',
  depreciationDrift:
    'UNWIRED — DEF-198. The should-versus-does reconciliation T-135 describes as an OIL finding. ' +
    'No detector reads it, so a depreciation outage stays invisible exactly as it did in v1.',
  declareSupplierItem:
    'UNWIRED — DEF-198. Which supplier sells which item has no screen, so the declaration ' +
    '`validateInvoiceLines` checks against can only be made by hand-run SQL.',
  undeclareSupplierItem: 'UNWIRED — DEF-198. The undo half of `declareSupplierItem`, same gap.',
  pendingItemRequests:
    'UNWIRED — DEF-198. `/items` wires `approveItemRequest` and `rejectItemRequest` but reads its ' +
    'queue through `itemsRepo`, so this gated read has no caller.',
  setItemPricing:
    'UNWIRED — DEF-198. An item’s pricing mode cannot be set from any screen, so branch ' +
    'pricing is whatever the seed left behind.',
  setCostBasisItem:
    'UNWIRED — DEF-198. Same screen gap as `setItemPricing`; the cost-basis link that stops an ' +
    'item pricing off itself can only be set by hand.',
  setTillFloat:
    'UNWIRED — DEF-198. `/till` wires open / close / count / charge-shortage; the float the count ' +
    'is judged against is not settable, so it is whatever it was seeded as.',
  previewDrawingClose:
    'UNWIRED — DEF-198. The dry run bible §13 row 160 asks for before `closeDrawingMonth` LOCKS ' +
    'the month for an owner. `/owners` calls the close directly, so the lock lands unpreviewed.',
  reverseOwnerEntry:
    'UNWIRED — DEF-198. A wrong contribution or drawing cannot be reversed from any screen, and ' +
    'the ledger is append-only, so there is no other correction path.',
  undoWriteOff:
    'UNWIRED — DEF-198. `/prepaid` wires `writeOffPrepaidItem` and not its undo, so a mistaken ' +
    'write-off is final.',
  addUsageLine:
    'UNWIRED — DEF-198. `/inventory/usage` saves a whole draft through `saveUsageDraft`; the ' +
    'per-line editors have no caller.',
  removeUsageLine: 'UNWIRED — DEF-198. The removal half of `addUsageLine`, same gap.',
  confirmTradeOrder:
    'UNWIRED — DEF-198. `/trade/orders` creates and dispatches; the draft -> confirmed transition ' +
    'in between has no screen, so `confirmTradeOrder`’s status gate can never fire.',
  closeYear:
    'UNWIRED — T-274 (`docs/tasks/274-adr-006-year-close-entry.md`). ADR-006\'s year-close journal ' +
    'entry, computed and posted through the existing `postEntry`. A screen or Server Action to ' +
    'reach it is explicitly scoped as a SECOND slice by the task\'s own briefing — building one now ' +
    'would be scope creep this task was told not to take. The first real year-close is Dec 2027 ' +
    '(ADR-006 intro), so nothing is on fire; delete this row when the screen lands.',

  // ---- T-289 — position access defaults: the spine ------------------------------------------
  reconcilePositionGrants:
    'INTERNAL — never reachable from a screen BY DESIGN. `createEmployment`, `endEmployment` and ' +
    '`setEmploymentPositions` (packages/domain/src/people/index.ts) call it at the five moments a ' +
    'human is present; `tests/unit/position-defaults-callers.test.ts` is the closed-importer guard ' +
    'that keeps it that way (T-289 §C11). Permanent — do not delete this row when T-290 lands.',
  // `setPositionDefault` and `retireStorePosition` carried UNWIRED rows here between T-289 and
  // T-290; T-290 (`apps/erp/src/app/admin/access-defaults/actions.ts`) is their caller, and this
  // guard's third `it` is what forced the rows out the moment that became true.

  // ---- T-336 — per-position access defaults at store creation -------------------------------
  seedStoreAccessDefaults:
    'INTERNAL — `createStore` calls it (`stores/service.ts` step 2c) to seed the ruled defaults ' +
    'on a brand-new store; there is no human boundary because there is nothing yet for a human to ' +
    'act on. `tests/unit/t336-canonical-position-defaults.test.ts`\'s U3 is the closed-caller-list ' +
    'guard that keeps it that way; it also owns the one required barrel re-export (§7:135).',
};

describe('T-227 — every action-shaped domain export is reachable from a screen', () => {
  const actions = actionShapedExports();
  const appSource = appProductionSource();
  const called = (name: string) => isCalledInSource(appSource, name);

  it('⭐ finds the domain actions and the app source at all (DEF-179 — a scan of nothing passes)', () => {
    // Floors, not ceremony: each collapses to zero if the enumeration breaks — a wrong root, a
    // failed `git ls-files`, a CRLF split that matches nothing.
    expect(actions.size).toBeGreaterThan(150);
    expect(appSource.length).toBeGreaterThan(100_000);
    // ⛔ And the guard must be able to SEE a caller, or "uncalled" would mean "unscanned" and the
    // exemption list would silently have to hold all 214.
    expect([...actions.keys()].filter(called).length).toBeGreaterThan(100);
  });

  it('⛔ every action-shaped export has an apps/ caller or a written exemption', () => {
    const orphans = [...actions]
      .filter(([name]) => !called(name) && EXEMPT[name] === undefined)
      .map(
        ([name, file]) =>
          `${name} (${file}) authorizes, so it presumes a human — and no file under apps/ calls it. ` +
          'Give it a screen, or add an EXEMPT entry naming which of the four kinds it is ' +
          '(internal / wrapper / job / unwired) and the other half.',
      )
      .sort();
    expect(orphans).toEqual([]);
  });

  it('⛔ no exemption outlives its reason — an entry whose export IS called must be deleted', () => {
    // Bible §13 row 138: an exemption matching nothing makes the rule look narrower than it is.
    const stale = Object.keys(EXEMPT)
      .map((name) => {
        if (!actions.has(name)) {
          return `${name} — exempted but no longer an action-shaped domain export. Delete the row.`;
        }
        if (called(name)) {
          return `${name} — exempted as having no caller, and apps/ now calls it. Delete the row; ` +
            'that is the whole point of the exemption being a confession rather than a setting.';
        }
        return null;
      })
      .filter((m): m is string => m !== null)
      .sort();
    expect(stale).toEqual([]);
  });

  it('⚠️ every exemption reason names its kind and says something', () => {
    const KINDS = /^(INTERNAL|WRAPPER|JOB|UNWIRED) —/;
    const weak = Object.entries(EXEMPT)
      .filter(([, reason]) => !KINDS.test(reason) || reason.trim().length < 60)
      .map(([name]) => `${name} — the reason must open with INTERNAL/WRAPPER/JOB/UNWIRED and say why`)
      .sort();
    expect(weak).toEqual([]);
  });
});

/**
 * T-375 S3 - the sales-day entry points, by name. `importSalesDay` is how a LINKED store gets a day and gains its
 * caller here (`importSalesDayAction`); `createSalesDay` and `editSalesDay` stay for UNLINKED stores and keep theirs.
 * Nothing in EXEMPT changes. Read from the file (not `git ls-files`) so an unstaged `import.ts` is still seen.
 */
describe('T-375 S3 - the day entry points keep or gain an apps/ caller', () => {
  const appSource = appProductionSource();
  const called = (name: string) => isCalledInSource(appSource, name);
  const importFile = path.join(repoRoot, 'packages/domain/src/sales-days/import.ts');

  it('importSalesDay is an actor-shaped export of sales-days/import.ts and an app action calls it', () => {
    expect(existsSync(importFile), 'packages/domain/src/sales-days/import.ts must exist').toBe(true);
    const src = codeOnly(readFileSync(importFile, 'utf8'));
    expect(/^export (?:async )?function importSalesDay\s*\(/m.test(src), 'importSalesDay must be exported from import.ts').toBe(true);
    expect(called('importSalesDay'), 'no file under apps/ calls importSalesDay').toBe(true);
    expect(EXEMPT.importSalesDay, 'importSalesDay needs no exemption: it has a caller').toBeUndefined();
  });

  it('control: createSalesDay and editSalesDay still have their callers', () => {
    expect(called('createSalesDay')).toBe(true);
    expect(called('editSalesDay')).toBe(true);
  });
});
