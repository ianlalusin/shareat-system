/**
 * T-511 S7a FIXES (fixer, 8 Nov 2026) - source scans for the audit rulings. No database. Comments are stripped before scanning code.
 *   6  `correctPlatformSales` has exactly ONE production caller (approve.ts): the lock order line -> sales day depends on it. Adding another is a deliberate act that must change this test.
 *   7  `recordChannelSettlement` takes the channel lock itself, after the gate and before the balance is read.
 *   3  `markVoided` is guarded in its WHERE (status = 'posted') and `voidChannelSettlement` takes the channel lock before it reads the status.
 *   8  the README of the channel settlements names the limit of a Grab day merged from several Transactions files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string): string => stripComments(read(rel));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/[\\/]tests[\\/]/.test(full)) out.push(full);
  }
  return out;
}
const rel = (p: string): string => p.slice(ROOT.length + 1).replace(/\\/g, '/');

describe('S7a fix 6 - correctPlatformSales has one production caller', () => {
  it('only approve.ts calls it (correction.ts defines it, the channel-settlements index only re-exports it) [kills: a second caller that breaks the lock order line then sales day]', () => {
    const files = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'apps'))];
    const callers = files.filter((f) => rel(f) !== 'packages/domain/src/channel-settlements/correction.ts' && /\bcorrectPlatformSales\(/.test(stripComments(readFileSync(f, 'utf8')))).map(rel);
    expect(callers).toEqual(['packages/domain/src/settlement-intake/approve.ts']);
  });
  it('correction.ts says so next to the function, where the next person will read it [kills: an undocumented lock-order dependency]', () => {
    expect(read('packages/domain/src/channel-settlements/correction.ts')).toMatch(/approve is the ONLY caller/i);
  });
});

describe('S7a fix 7 - recordChannelSettlement serialises on the channel', () => {
  it('lockSettlementChannel( comes after the authorize and before the context (balance) read [kills: a manual settlement racing an approve on the same balance]', () => {
    const src = code('packages/domain/src/channel-settlements/index.ts');
    const start = src.indexOf('export async function recordChannelSettlement(');
    const body = src.slice(start, src.indexOf('\nexport ', start + 10));
    const auth = body.search(/\bauthorize\(/);
    const lock = body.search(/lockSettlementChannel\(/);
    const read = body.search(/gatherSettlementContext\(/);
    expect(auth).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(auth);
    expect(read).toBeGreaterThan(lock);
  });
});

describe('S7a fix 3 - a void is guarded twice', () => {
  it('markVoided only updates a posted settlement and says whether it did [kills: a second voider overwriting the first reason]', () => {
    const src = code('packages/db/src/repo/channel-settlements.ts');
    const start = src.indexOf('export async function markVoided(');
    const body = src.slice(start, src.indexOf('\nexport ', start + 10));
    expect(body).toMatch(/eq\(channelSettlements\.status, 'posted'\)/);
    expect(body).toMatch(/\.returning\(/);
  });
  it('voidChannelSettlement takes the channel lock before it reads the status, and refuses an already voided one in words [kills: status read before the lock]', () => {
    const src = code('packages/domain/src/channel-settlements/index.ts');
    const start = src.indexOf('export async function voidChannelSettlement(');
    const body = src.slice(start, src.indexOf('\nexport ', start + 10));
    const lock = body.search(/lockSettlementChannel\(/);
    const status = body.search(/\.status !== 'posted'/);
    expect(lock).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(lock);
    expect(body).toMatch(/already voided/);
  });
});

describe('S7a fix 8 - the limit is written down', () => {
  it('the channel-settlements README names the merged Grab files limit [kills: a limit nobody wrote down]', () => {
    expect(read('packages/domain/src/channel-settlements/README.md')).toMatch(/several Transactions files/i);
  });
});
