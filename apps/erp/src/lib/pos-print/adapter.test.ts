// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * T-528 R4 (TESTER) - the print adapter. docs/tasks/528-pos-payment-screen.md R4.
 *
 * ASSUMED API (the builder matches these or says why not):
 *   apps/erp/src/lib/pos-print/adapter.ts  exports  printLines(lines: string[], opts: { copies: number }): Promise<'printed' | 'fallback' | 'failed'>
 *   The APK plugin (T-530) is `window.ShareatPrinter` with ONE method  print(lines: string[], opts: { copies: number }): void | Promise<void>.
 *   No plugin: a print-only view (a monospace <pre> holding the lines joined by "\n") is put in the document, `window.print()` is called, result 'fallback'.
 *   The plugin throwing (sync) or rejecting -> 'failed', and the browser print is NOT used as a hidden retry.
 *
 * RED NOW FOR THE RIGHT REASON: adapter.ts does not exist (lazy import: "MISSING MODULE ... not built").
 */
async function adapter(): Promise<{ printLines: (lines: string[], opts: { copies: number }) => Promise<'printed' | 'fallback' | 'failed'> }> {
  try {
    const path = './adapter';
    return await import(/* @vite-ignore */ path);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/lib/pos-print/adapter.ts cannot be loaded (T-528 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}

const LINES = ['      SHAREAT LIPA', 'TOTAL                   2,092.42', 'CHANGE                      7.58'];
const w = window as unknown as { ShareatPrinter?: unknown; print: () => void };
w.print ??= () => undefined; // happy-dom has no window.print; the spies below need one to wrap

afterEach(() => {
  delete w.ShareatPrinter;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('printLines (T-528 R4)', () => {
  it('plugin present -> called once with the lines and the copies, result "printed", the browser print is not used', async () => {
    const { printLines } = await adapter();
    const print = vi.fn();
    w.ShareatPrinter = { print };
    const browser = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    expect(await printLines(LINES, { copies: 2 })).toBe('printed');
    expect(print).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledWith(LINES, { copies: 2 });
    expect(browser).not.toHaveBeenCalled();
  });

  it('an async plugin is awaited: "printed" only after it resolves', async () => {
    const { printLines } = await adapter();
    let done = false;
    w.ShareatPrinter = { print: () => new Promise<void>((r) => setTimeout(() => ((done = true), r()), 10)) };
    expect(await printLines(LINES, { copies: 1 })).toBe('printed');
    expect(done).toBe(true);
  });

  it('no plugin -> a monospace <pre> with the lines is in the document when window.print() runs, and the result is "fallback"', async () => {
    const { printLines } = await adapter();
    let seen: { text: string | null; family: string } | null = null;
    vi.spyOn(window, 'print').mockImplementation(() => {
      const pre = document.querySelector('pre');
      seen = { text: pre?.textContent ?? null, family: pre ? (pre.style.fontFamily || pre.className) : '' };
    });
    expect(await printLines(LINES, { copies: 1 })).toBe('fallback');
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(seen).not.toBeNull();
    expect(seen!.text).toBe(LINES.join('\n'));
    expect(seen!.family.toLowerCase()).toMatch(/mono|courier/);
  });

  it('a plugin that throws -> "failed"; the browser print is not tried; nothing is thrown at the caller', async () => {
    const { printLines } = await adapter();
    w.ShareatPrinter = {
      print: () => {
        throw new Error('printer is off');
      },
    };
    const browser = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await expect(printLines(LINES, { copies: 1 })).resolves.toBe('failed');
    expect(browser).not.toHaveBeenCalled();
  });

  it('a plugin that rejects -> "failed"', async () => {
    const { printLines } = await adapter();
    w.ShareatPrinter = { print: () => Promise.reject(new Error('paper out')) };
    await expect(printLines(LINES, { copies: 1 })).resolves.toBe('failed');
  });

  it('the browser fallback throwing -> "failed" as well, never an exception', async () => {
    const { printLines } = await adapter();
    vi.spyOn(window, 'print').mockImplementation(() => {
      throw new Error('blocked');
    });
    await expect(printLines(LINES, { copies: 1 })).resolves.toBe('failed');
  });

  it('the print view is NOT removed straight after window.print(): it stays until afterprint, then goes (with its style)', async () => {
    const { printLines } = await adapter();
    vi.spyOn(window, 'print').mockImplementation(() => undefined);
    expect(await printLines(LINES, { copies: 1 })).toBe('fallback');
    expect(document.querySelector('pre'), 'still in the document right after print() returned').not.toBeNull();
    window.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector('pre')).toBeNull();
    expect(document.getElementById('pos-print-style')).toBeNull();
  });

  it('with no afterprint event the print view is removed by the fallback timeout, not before', async () => {
    vi.useFakeTimers();
    try {
      const { printLines } = await adapter();
      vi.spyOn(window, 'print').mockImplementation(() => undefined);
      await printLines(LINES, { copies: 1 });
      vi.advanceTimersByTime(5_000);
      expect(document.querySelector('pre')).not.toBeNull();
      vi.advanceTimersByTime(6_000);
      expect(document.querySelector('pre')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a print that throws removes the view at once (nothing to wait for), and a second print replaces a stale view', async () => {
    const { printLines } = await adapter();
    const spy = vi.spyOn(window, 'print').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(await printLines(LINES, { copies: 1 })).toBe('failed');
    expect(document.querySelector('pre')).toBeNull();
    spy.mockImplementation(() => undefined);
    await printLines(LINES, { copies: 1 });
    await printLines(['second'], { copies: 1 });
    expect(document.querySelectorAll('pre')).toHaveLength(1);
    expect(document.querySelector('pre')!.textContent).toBe('second');
  });
});
