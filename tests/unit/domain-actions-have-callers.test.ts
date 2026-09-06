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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const DOMAIN_ROOT = 'packages/domain/src/';

/**
 * ⛔ `git ls-files`, never a directory walk. `apps/erp/.next` holds turbopack copies of the domain
 * barrel and matches **every** symbol in it, so a walk would report every export as called and pass
 * for ever. `.next` is gitignored, so enumerating from git cannot see it — structural, not a rule
 * anyone has to remember. (`docs/CAPABILITY-GAPS.md`, the sweep's first trap.)
 *
 * ⭐ `--others --exclude-standard` includes files not yet staged — a service written five
 * minutes ago is exactly the one at risk of shipping uncalled — while still honouring
 * `.gitignore`, so `.next` remains invisible.
 */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/**
 * ⛔ Comments stripped before matching. Names are mentioned constantly in this codebase's prose —
 * `reconcileSupplier` appears in three of its own error strings and a doc block — and a raw text
 * match would call a dead export live. ⚠️ CRLF is normalised first: this repo checks out CRLF and
 * `.` does not match `\r`, so a line-oriented scan can match nothing and pass (DEF-179).
 */
function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

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

function appProductionSource(): string {
  return trackedFiles()
    .filter((f) => f.startsWith('apps/') && /\.(ts|tsx)$/.test(f) && !isTest(f))
    .map(read)
    .join('\n');
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
  // ---- 1. internal: called by another domain function that is itself wired -------------------
  recordCharge:
    'INTERNAL — `dispatchTradeOrder` calls it (`trade/index.ts:460`); dispatch IS the billing ' +
    'event. ⚠️ The LAST of DEF-190’s five still without a screen: a charge raised outside a trade ' +
    'order is T-226 §6, and it is blocked on Ian deciding which revenue account a manual credit ' +
    'sale credits — no wholesale-revenue account exists in the chart.',
  capitalizeApprovedExpense:
    'INTERNAL — `approveExpense` calls it for a CAPEX category (`expenses/approve.ts:231`). It is ' +
    'deliberately not a human boundary: the caller is approving an expense, not managing assets.',
  retireAssetFromVoidedExpense:
    'INTERNAL — `voidExpense` calls it (`expenses/void.ts:68`) so voiding the expense retires the ' +
    'asset it created, in the same transaction.',
  writeChannels:
    'INTERNAL — `createSalesDay` calls it (`sales-days/create.ts:206`) to write the per-channel ' +
    'rows a sales day owns. Exported for its types, not as an entry point.',

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
  payReimbursement:
    'UNWIRED — DEF-198. T-208 built the clearing path for `2130 Reimbursements payable to ' +
    'employees` and no screen calls it, so a staff reimbursement is booked and never paid off.',
  readFileUrl:
    'UNWIRED — DEF-198. The ONLY way to view an uploaded receipt photo: a short-lived signed URL ' +
    'minted per request. Nothing displays one, so evidence can be attached and never looked at.',
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
  deactivateItem:
    'UNWIRED — DEF-198. `/items` wires create / update / merge / request / approve / reject and ' +
    'not this, so an item can be created and never retired.',
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
  createRecipe:
    'UNWIRED — DEF-198. `/inventory/production` LISTS recipes (`productionRepo.listRecipes`) and ' +
    'nothing creates one, so a cook run has no recipe to run unless one is inserted by hand.',
  addUsageLine:
    'UNWIRED — DEF-198. `/inventory/usage` saves a whole draft through `saveUsageDraft`; the ' +
    'per-line editors have no caller.',
  removeUsageLine: 'UNWIRED — DEF-198. The removal half of `addUsageLine`, same gap.',
  confirmTradeOrder:
    'UNWIRED — DEF-198. `/trade/orders` creates and dispatches; the draft -> confirmed transition ' +
    'in between has no screen, so `confirmTradeOrder`’s status gate can never fire.',
};

describe('T-227 — every action-shaped domain export is reachable from a screen', () => {
  const actions = actionShapedExports();
  const appSource = appProductionSource();
  const called = (name: string) => new RegExp(`\\b${name}\\b`).test(appSource);

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
