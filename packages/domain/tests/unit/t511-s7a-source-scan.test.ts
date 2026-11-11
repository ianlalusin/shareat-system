/**
 * T-511 S7a (TESTER, 8 Nov 2026) - source scans of `settlement-intake/approve.ts` and its wiring. No database. Reads source text; comments are stripped before scanning
 * code, so a history note may still say what used to be. docs/tasks/511-settlement-upload-s7-spec.md Rulings 1-3 and 5, the no-hard-coded-business-values rule.
 *
 * RED TODAY: approve.ts does not exist.
 *
 *  A1  Not on the barrel by accident: `approveDay` is exported from `packages/domain/src/index.ts`; `NEEDS_REASON` is one of the intake refusal codes and approve.ts raises it.
 *  A2  No hard-coded account code or amount in approve.ts: no quoted account number, no `accountCode:` literal, no quoted decimal, no bare 3+ digit number. Every account is
 *      reached through the named constants of the channel-settlement repo, by the functions it calls (approve books through `recordChannelSettlement` and `correctPlatformSales`).
 *  A3  Authorize before any figure: an `authorize` call precedes the first read of a money field of the line and the first call of the blocker, mapping, preview,
 *      correction or settlement functions.
 *  A4  One clock: no `Date`, `now()`, `current_date`, `toBusinessDate` in approve.ts; it reads `manilaToday(` once and hands that date to `dayBlockers`.
 *  A5  Plain words: no raw `throw new Error(`, no SQL text and no table or constraint name in any string literal; refusals go through the intake refusal helper or `refuse`.
 *  A6  The order of Ruling 2: the channel lock (`advisoryLocksRepo.lockSettlementChannel(`) before the locked read (`forUpdate: true`), then the blockers re-run, then the
 *      correction, then the settlement, then `markBooked(`, then the audit write. No nested `transaction(` and no empty `catch` (one transaction; a throw rolls everything back).
 *  A7  The writes have one door each: `markBooked(` is called only from approve.ts, `markUnbooked(` only from `voidChannelSettlement`'s file (channel-settlements/index.ts).
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const APPROVE = join(ROOT, 'packages', 'domain', 'src', 'settlement-intake', 'approve.ts');
const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const exists = existsSync(APPROVE);
const code = exists ? stripComments(readFileSync(APPROVE, 'utf8')) : '';
/** every string literal of the code (a quote of any kind), without its quotes */
const strings = (src: string): string[] => [...src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2] as string);
const noStrings = (src: string): string => src.replace(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g, '""');
const first = (re: RegExp): number => code.search(re);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (p: string): string => p.slice(ROOT.length + 1).replace(/\\/g, '/');

describe('T-511 S7a - approve.ts exists and is reachable', () => {
  it('approve.ts exists, approveDay is on the barrel, NEEDS_REASON is a refusal code and approve raises it [kills: a function nobody can import; an untyped reason refusal]', () => {
    expect(exists, 'packages/domain/src/settlement-intake/approve.ts').toBe(true);
    expect(code).toMatch(/export async function approveDay\(/);
    expect(readFileSync(join(ROOT, 'packages/domain/src/index.ts'), 'utf8')).toMatch(/\bapproveDay\b/);
    expect(readFileSync(join(ROOT, 'packages/domain/src/settlement-intake/refusal.ts'), 'utf8')).toContain("'NEEDS_REASON'");
    expect(code).toContain('NEEDS_REASON');
  });
});

describe('T-511 S7a - A2: nothing hard-coded', () => {
  it('no quoted account number, no accountCode literal, no quoted decimal amount, no bare number of three digits or more [kills: an account code or an amount typed into the approve path]', () => {
    expect(exists).toBe(true);
    expect(strings(code).filter((s) => /^[1-9]\d{3}$/.test(s)), 'a quoted account number').toEqual([]);
    expect(code).not.toMatch(/accountCode:\s*['"`]/);
    expect(strings(code).filter((s) => /^-?\d+\.\d{2}$/.test(s)), 'a quoted decimal amount').toEqual([]);
    expect(noStrings(code).match(/(?<![\w.])\d{3,}(?![\w.])/g) ?? [], 'a bare number').toEqual([]);
  });
});

describe('T-511 S7a - A3: authorize before any figure is read', () => {
  it('an authorize call comes before the first money field read and before the blocker, mapping, preview, correction and settlement calls [kills: figures read or posted before the permission check]', () => {
    expect(exists).toBe(true);
    const auth = first(/\bauthorize\w*\(/);
    expect(auth, 'an authorize call').toBeGreaterThan(-1);
    const firstField = first(/\.(orderValue|netPayout|commission|marketing|platformFee|loanDeduction|recordedFigure|difference)\b/);
    if (firstField > -1) expect(auth).toBeLessThan(firstField);
    for (const call of ['dayBlockers', 'lineToSettlementInput', 'previewChannelSettlement', 'correctPlatformSales', 'recordChannelSettlement']) {
      const at = first(new RegExp(`\\b${call}\\(`));
      if (at > -1) expect(auth, `${call}( after the gate`).toBeLessThan(at);
    }
  });
});

describe('T-511 S7a - A4: one clock', () => {
  it('no Date, no now(), no current_date, no toBusinessDate; manilaToday( is read and its date is passed to dayBlockers [kills: a second clock, so "will post on X" and the actual date can differ]', () => {
    expect(exists).toBe(true);
    expect(noStrings(code)).not.toMatch(/\bDate\b|\bnow\(\)|current_date|toBusinessDate/i);
    expect(code).toMatch(/manilaToday\(/);
    expect(code).toMatch(/dayBlockers\([\s\S]{0,300}?\btoday\b/);
  });
});

describe('T-511 S7a - A5: plain words', () => {
  it('no raw throw new Error, no SQL and no table or constraint name in any string [kills: a database error shown to a manager]', () => {
    expect(exists).toBe(true);
    expect(code).not.toMatch(/throw new Error\(/);
    for (const s of strings(code)) {
      expect(s, `string: ${s}`).not.toMatch(/\b(select|insert|update|delete)\b[\s\S]*\b(from|into|set|where|values)\b/i);
      expect(s, `string: ${s}`).not.toMatch(/settlement_day_lines|journal_entries|channel_settlements|sales_day_platform_corrections|constraint|violates|sqlstate|null value/i);
    }
  });
});

describe('T-511 S7a - A6: the order of Ruling 2, in one transaction', () => {
  it('lock the channel, read the line FOR UPDATE, re-run the blockers, correct, settle, mark booked, audit [kills: the lock after the read (a race); blockers read once before the lock; the audit before the write; a settlement before its correction]', () => {
    expect(exists).toBe(true);
    const marks = [
      ['lockSettlementChannel(', first(/\blockSettlementChannel\(/)],
      ['forUpdate: true', first(/forUpdate:\s*true/)],
      ['dayBlockers(', first(/\bdayBlockers\(/)],
      ['correctPlatformSales(', first(/\bcorrectPlatformSales\(/)],
      ['recordChannelSettlement(', first(/\brecordChannelSettlement\(/)],
      ['markBooked(', first(/\bmarkBooked\(/)],
      ['auditLogRepo.append(', first(/auditLogRepo\.append\(/)],
    ] as const;
    for (const [name, at] of marks) expect(at, `${name} is in approve.ts`).toBeGreaterThan(-1);
    for (let i = 1; i < marks.length; i++) expect(marks[i - 1]![1], `${marks[i - 1]![0]} before ${marks[i]![0]}`).toBeLessThan(marks[i]![1]);
    expect(code).toMatch(/advisoryLocksRepo\.lockSettlementChannel\(/);
  });
  it('approve opens no transaction of its own and swallows nothing: no transaction(, no savepoint, no empty catch [kills: a partial commit; a swallowed failure that leaves a half-booked day]', () => {
    expect(exists).toBe(true);
    expect(code).not.toMatch(/\btransaction\(|savepoint|\.begin\(/i);
    expect(code).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
  });
  it('the mapping gets what Ruling 3 says: the typed reason, the date it will post on and the carrier charges [kills: an approve that maps a bare line]', () => {
    expect(exists).toBe(true);
    expect(code).toMatch(/lineToSettlementInput\(/);
    expect(code).toMatch(/differenceReason/);
    expect(code).toMatch(/willPostOn/);
    expect(code).toMatch(/charges/);
  });
});

describe('T-511 S7a - A7: each booking write has one door', () => {
  const files = walk(join(ROOT, 'packages', 'domain', 'src')).map((f) => ({ f: rel(f), text: stripComments(readFileSync(f, 'utf8')) }));
  const callers = (name: string): string[] => files.filter((x) => new RegExp(`\\b${name}\\(`).test(x.text)).map((x) => x.f);
  it('markBooked( is called from approve.ts only [kills: a second path that books a day without the approve checks]', () => {
    expect(callers('markBooked')).toEqual(['packages/domain/src/settlement-intake/approve.ts']);
  });
  it('markUnbooked( is called from the channel-settlement void only, never from a screen path or review.ts [kills: a day returned to pending by anything but a void]', () => {
    expect(callers('markUnbooked')).toEqual(['packages/domain/src/channel-settlements/index.ts']);
  });
});
