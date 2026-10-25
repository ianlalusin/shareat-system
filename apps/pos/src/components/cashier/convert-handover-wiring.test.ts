/** Source wiring controls supplement the numerical/route tests; they are not a browser smoke test. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
function arrow(source: string, name: string): string {
  const file = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = '';
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isArrowFunction(node.initializer)) {
      body = node.initializer.body.getText(file);
    }
    ts.forEachChild(node, walk);
  };
  walk(file); return body;
}

describe('T427 cash UI wiring', () => {
  it('handover refreshes server totals for the closing window before constructing and writing the record', () => {
    const source = read('./CashHandoverClient.tsx');
    const body = arrow(source, 'handleSave');
    const readAt = body.indexOf('await computeHandoverCash(');
    const buildAt = body.indexOf('buildHandoverRecord(');
    const persistAt = body.indexOf('saveHandoverAttempt(');
    const writeAt = body.indexOf('await commitHandover(');
    expect(readAt).toBeGreaterThan(0); expect(buildAt).toBeGreaterThan(readAt);
    expect(persistAt).toBeGreaterThan(buildAt); expect(writeAt).toBeGreaterThan(persistAt);
    expect(body).toContain('let request = attempt'); expect(body).toContain('if (!request)');
    expect(body).toContain('savingNow.current'); expect(body).not.toContain('addDoc(');
    expect(source).toContain('readHandoverAttempt(localStorage');
    expect(source).toContain('<fieldset disabled={formLocked}');
    expect(source).toContain('!formLocked && priorReady');
    expect(source).toContain('const snap = await getDocsFromServer(');
    expect(source).toContain('priorReady ? recompute(periodStartMs) : setPriorRetry');
    expect(body).toContain('cashSales: fresh.cashSales'); expect(body).toContain('convertNet: fresh.convertNet');
    expect(body).toContain('cashRefunds: fresh.cashRefunds'); // bible row 391: cash refunds come off the saved expected cash
    expect(read('./CashHandoverClient.tsx')).toContain('cashRefunds,'); // and off the on-screen expected cash
    expect(body).toContain('periodEndMs: now'); expect(body).toContain('periodStartExclusive: hasPrior');
    expect(body).toContain('...figures');
    expect(body).toContain('handoverReadFrom(periodStartMs, hasPrior)');
    expect(source).not.toMatch(/\bNumber\((?:startingCash|cashSales|countedCash|dedAmount)\)/);
  });
  it('the cashier launches Convert; retry envelope persists before the request, and cached lists cannot unlock its discard action', () => {
    expect(read('./session-list-view.tsx')).toContain('<ConvertSheet');
    const source = read('./ConvertSheet.tsx');
    const body = arrow(source, 'save');
    expect(body.indexOf('sessionStorage.setItem(')).toBeGreaterThan(0);
    expect(body.indexOf('await postPos2')).toBeGreaterThan(body.indexOf('sessionStorage.setItem('));
    expect(body).toContain('attempt ??'); expect(body).toContain('setAttempt(request)');
    expect(source).toContain('setLoading(snap.metadata.fromCache)');
    expect(source).toContain('busy || loading || rowsFailed || !online');
  });
  it('handover history and export show conversion and manual adjustment amounts separately', () => {
    const source = read('./CashHandoverClient.tsx');
    expect(source).toContain('"Convert and tender fixes": h.convertNet ?? 0');
    expect(source).toContain('"Manual cash adjustment": h.manualCashAdjustment ?? 0');
    expect(source).toContain('"Adjustment reason": h.manualCashAdjustmentReason');
    expect(source).toContain('md:hidden'); expect(source).toContain('hidden overflow-x-auto md:block');
  });
});
