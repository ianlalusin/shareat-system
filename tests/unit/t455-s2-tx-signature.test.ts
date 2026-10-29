/**
 * T-455 S2 (TESTER) - "every function's signature requires `tx`" (docs/tasks/455-customer-lobby.md section 5 S2 row, section 2.7, DEF-421).
 * Proposed path: tests/unit/t455-s2-tx-signature.test.ts. Style follows tests/unit/t398-s2-domain-tx-non-nullable.test.ts (comments
 * stripped, pure fs scan of packages/domain/src, balanced-paren parameter extraction).
 *
 * RED TODAY: packages/domain/src/lobby/ does not exist (the directory read fails, and the type-level block below does not compile).
 *
 * Two layers, because each catches what the other cannot:
 *  1. COMPILE TIME (tsc / the typecheck gate): `IsTx<Parameters<typeof f>[0]>` must be exactly `Tx`. A `Tx | null`, `Tx | undefined`,
 *     an optional `tx?:` or a different first parameter makes the `true` literal a type error.
 *  2. RUN TIME (vitest): a source scan of packages/domain/src/lobby/*.ts: every exported function's first parameter is named `tx`
 *     and typed exactly `Tx`; the exported-function set equals the pinned list (a new or renamed function must update this file); no
 *     import of `transaction` / `systemTransaction` / `authTransaction` from @shareat/db (a domain function never opens its own
 *     transaction, DEF-421; the org LISTING for the nightly job is the scheduler glue's job under systemTransaction, DEF-742).
 *
 * MUTANTS: `tx: Tx | null` on any function; `tx?: Tx`; `tx` moved to the second parameter; a new exported helper without tx;
 * a function that calls `transaction(` itself; a renamed export with the pin not updated; a pure helper exported by mistake.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Tx } from '@shareat/db';
import type { cancelMyEntry, checkIn, getMyEntry, lobbyPartiesAhead } from '../../packages/domain/src/lobby/checkin';
import type { callEntry, listLobbyEntries, parkWalkIn, removeEntry, seatEntry } from '../../packages/domain/src/lobby/staff';
import type { expireStaleLobbyEntries, purgeLobbyPersonalData, runLobbyNightly, sweepStalePendingClaims } from '../../packages/domain/src/lobby/purge';

// ---------------------------------------------------------------------------------------------- layer 1: compile time
type IsTx<T> = [T] extends [Tx] ? ([Tx] extends [T] ? true : false) : false;
export const compileTimeProof: Record<string, true> = {
  checkIn: true as IsTx<Parameters<typeof checkIn>[0]>,
  getMyEntry: true as IsTx<Parameters<typeof getMyEntry>[0]>,
  cancelMyEntry: true as IsTx<Parameters<typeof cancelMyEntry>[0]>,
  lobbyPartiesAhead: true as IsTx<Parameters<typeof lobbyPartiesAhead>[0]>,
  parkWalkIn: true as IsTx<Parameters<typeof parkWalkIn>[0]>,
  listLobbyEntries: true as IsTx<Parameters<typeof listLobbyEntries>[0]>,
  callEntry: true as IsTx<Parameters<typeof callEntry>[0]>,
  seatEntry: true as IsTx<Parameters<typeof seatEntry>[0]>,
  removeEntry: true as IsTx<Parameters<typeof removeEntry>[0]>,
  expireStaleLobbyEntries: true as IsTx<Parameters<typeof expireStaleLobbyEntries>[0]>,
  sweepStalePendingClaims: true as IsTx<Parameters<typeof sweepStalePendingClaims>[0]>,
  purgeLobbyPersonalData: true as IsTx<Parameters<typeof purgeLobbyPersonalData>[0]>,
  runLobbyNightly: true as IsTx<Parameters<typeof runLobbyNightly>[0]>,
};

// ---------------------------------------------------------------------------------------------- layer 2: run time
const here = dirname(fileURLToPath(import.meta.url));
const LOBBY_SRC = resolve(here, '..', '..', 'packages', 'domain', 'src', 'lobby');

/** The exported functions S2 owns, pinned BY VALUE per file. Adding, renaming or removing one means editing this list. */
const PINNED: Record<string, string[]> = {
  'checkin.ts': ['cancelMyEntry', 'checkIn', 'getMyEntry', 'lobbyPartiesAhead'],
  'staff.ts': ['callEntry', 'listLobbyEntries', 'parkWalkIn', 'removeEntry', 'seatEntry'],
  'purge.ts': ['expireStaleLobbyEntries', 'purgeLobbyPersonalData', 'runLobbyNightly', 'sweepStalePendingClaims'],
  // T-455 S5: the shared core of the cashier moves and the POS tablet's moves (each takes tx: Tx first).
  'core.ts': ['callCore', 'listCore', 'parkCore', 'removeCore', 'seatCore'],
  'terminal.ts': ['callForTerminal', 'listForTerminal', 'parkForTerminal', 'removeForTerminal', 'seatForTerminal', 'setLobbyPausedForTerminal'],
};
/** Exported functions that are allowed to have no `tx` (pure helpers). Empty on purpose: keep helpers unexported (CONTRACT QUESTION 9). */
const NO_TX_ALLOWED: string[] = [];

/** Block comments and `//` line comments out (a `//` right after `:` is a URL scheme, kept). */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const read = (file: string) => strip(readFileSync(join(LOBBY_SRC, file), 'utf8'));

/** The text of the balanced `( ... )` that opens at `open` (index of the '('). */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Every exported function (declaration or `export const f = (...) =>` arrow) with its raw parameter list. */
function exportedFunctions(src: string): Array<{ name: string; params: string }> {
  const out: Array<{ name: string; params: string }> = [];
  const decl = /export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^(]*?>)?\s*\(/g;
  const arrow = /export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^(]*?>\s*)?\(/g;
  for (const re of [decl, arrow]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) out.push({ name: m[1] as string, params: balanced(src, m.index + m[0].length - 1) });
  }
  return out;
}

/** The first parameter's text, split at the first top-level comma. */
function firstParam(params: string): string {
  let depth = 0;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (c === '(' || c === '<' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '>' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) return params.slice(0, i).trim();
  }
  return params.trim();
}

describe('T-455 S2: every exported lobby function requires `tx: Tx` as its first parameter (DEF-421)', () => {
  it('the lobby directory holds exactly checkin.ts, staff.ts, purge.ts (+ refusal.ts, no other module with exports) [kills: a stray module that dodges this scan]', () => {
    const files = readdirSync(LOBBY_SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
    for (const want of Object.keys(PINNED)) expect(files, `${want} missing`).toContain(want);
    const extra = files.filter((f) => !(f in PINNED) && f !== 'refusal.ts');
    expect(extra, 'a new lobby module must be added to PINNED in this test').toEqual([]);
  });

  for (const [file, names] of Object.entries(PINNED)) {
    it(`${file}: the exported functions are exactly [${names.join(', ')}] [kills: a renamed, added or removed function with this list not updated]`, () => {
      const found = exportedFunctions(read(file)).map((f) => f.name).sort();
      expect(found).toEqual([...names].sort());
    });

    it(`${file}: every exported function's first parameter is \`tx: Tx\` - not \`Tx | null\`, not optional, not renamed [kills: Tx | null, tx?:, tx moved]`, () => {
      const bad: string[] = [];
      for (const f of exportedFunctions(read(file))) {
        if (NO_TX_ALLOWED.includes(f.name)) continue;
        const first = firstParam(f.params);
        if (!/^tx\s*:\s*Tx$/.test(first)) bad.push(`${f.name}(${first || '<no parameters>'})`);
      }
      expect(bad, `first parameter must be exactly "tx: Tx":\n${bad.join('\n')}`).toEqual([]);
    });
  }

  it('no lobby module opens its own transaction: no `transaction`, `systemTransaction` or `authTransaction` import from @shareat/db, no bare `transaction(` call [kills: a function that ignores the caller\'s tx]', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(LOBBY_SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = read(file);
      if (/import\s*\{[^}]*\b(?:transaction|systemTransaction|authTransaction)\b[^}]*\}\s*from\s*['"]@shareat\/db(?:\/client)?['"]/.test(src)) offenders.push(`${file}: imports a transaction opener`);
      if (/(?<![.\w$])(?:transaction|systemTransaction|authTransaction)\(/.test(src)) offenders.push(`${file}: calls a transaction opener`);
    }
    expect(offenders).toEqual([]);
  });

  it('the compile-time proof is itself checked: the IsTx helper rejects Tx | null, Tx | undefined and optional (self-test of this file) [kills: a vacuous IsTx that accepts anything]', () => {
    type Yes = IsTx<Tx>;
    type NoNull = IsTx<Tx | null>;
    type NoUndef = IsTx<Tx | undefined>;
    const yes: Yes = true;
    const noNull: NoNull = false;
    const noUndef: NoUndef = false;
    expect([yes, noNull, noUndef]).toEqual([true, false, false]);
  });
});
