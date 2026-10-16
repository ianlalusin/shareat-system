import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * T-435 case 36 (TESTER) - every reader that returns personal data takes the full Actor, not an orgId.
 * Spec: docs/tasks/435-personal-data-access-gates.md case 36 / design 4; bible row 353 (the check lives where the data is READ).
 *
 * Why a source scan: a loader that takes `orgId: string` CANNOT authorize (it has no person to check), so it is a reader that any
 * future CSV or print route could call and bypass the scope. Forcing the Actor into the signature keeps every present and future
 * caller on the same gate. M36: revert `rosterFor` to `(orgId, storeId)`.
 *
 * The list below is the set the spec names (payroll, 13th-month, separations, customers, staff). It is deliberately an explicit
 * list, not "every export": `listStores`, `positionsForStore` (store names / position names, not personal data) and the price-list
 * readers (open by Ian Q3) stay on orgId. A reader that is missing from its file fails the test, so a rename cannot hide.
 */
const app = path.resolve(__dirname, '../src/app');

const READERS: Record<string, string[]> = {
  'payroll/lib.ts': ['rosterFor', 'runsFor', 'slipsFor', 'cashAccountsFor', 'premiumSettingsFor'],
  'payroll/thirteenth-month/lib.ts': ['runsFor', 'payoutsFor'],
  'payroll/separations/lib.ts': ['worklistFor', 'separationsFor'],
  'customers/lib.ts': [
    'listRegister',
    'getCustomer',
    'getPosition',
    'creditBalance',
    'listCharges',
    'listCollections',
    'openItemsFor',
    'storesWithOpenItems',
    'moneyAccountsFor',
  ],
  'staff/lib.ts': ['rosterForStore', 'employmentDetail', 'livePinFor', 'otherOpenBranchesFor'],
};

/** Source with comments removed, so prose about `orgId` cannot satisfy or fail the scan. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/** The text of the first parameter of `export async function name(...)`, or null when there is no such export. */
function firstParam(src: string, name: string): string | null {
  const m = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(([\\s\\S]*?)\\)\\s*(?::|\\{)`).exec(src);
  if (!m) return null;
  const params = m[1]!.trim();
  // First top-level parameter: stop at the first comma outside <>, {}, [].
  let depth = 0;
  for (let i = 0; i < params.length; i++) {
    const ch = params[i]!;
    if ('<{[('.includes(ch)) depth++;
    else if ('>}])'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) return params.slice(0, i).trim();
  }
  return params;
}

describe('T-435 case 36 - readers of personal data take actor: Actor (M36: revert rosterFor to (orgId, storeId))', () => {
  for (const [file, names] of Object.entries(READERS)) {
    const src = codeOnly(readFileSync(path.join(app, file), 'utf8'));
    for (const name of names) {
      it(`${file}: ${name}(actor: Actor, ...)`, () => {
        const first = firstParam(src, name);
        expect(first, `${file} no longer exports an async function ${name}`).not.toBeNull();
        expect(first, `${name} must take the full Actor first`).toMatch(/^actor\s*:\s*Actor\b/);
      });
    }
  }

  it('the scan really reads a signature (a known orgId-first reader is seen as such)', () => {
    const src = codeOnly(readFileSync(path.join(app, 'staff/lib.ts'), 'utf8'));
    expect(firstParam(src, 'positionsForStore')).toMatch(/^orgId\s*:\s*string$/);
  });
});
