// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { printLines, printerMode } from './adapter';
import { forPrinter, installPrinterBridge, printViaPlugin, printerErrorMessage, type SavedPrinter, type ThermalPrinterPlugin } from './native';
import { testSlipLines } from './test-slip';

/** T-532 S1 — the native bridge, against a fake window.Capacitor.Plugins.ThermalPrinter. */
const SAVED: SavedPrinter = { address: 'AA:BB', name: 'Printer', widthMm: 58, font: 'normal' };
const w = window as unknown as { Capacitor?: unknown; ShareatPrinter?: unknown };

function fake(over: { printReceipt?: ReturnType<typeof vi.fn<ThermalPrinterPlugin['printReceipt']>> } = {}) {
  const plugin = {
    listBluetoothPrinters: vi.fn(async () => ({ devices: [] })),
    connectBluetoothPrinter: vi.fn(async () => undefined),
    disconnectBluetoothPrinter: vi.fn(async () => undefined),
    printReceipt: over.printReceipt ?? vi.fn<ThermalPrinterPlugin['printReceipt']>(async () => undefined),
  };
  w.Capacitor = { Plugins: { ThermalPrinter: plugin } };
  return plugin;
}

afterEach(() => {
  delete w.Capacitor;
  delete w.ShareatPrinter;
});

describe('printer bridge (T-532 S1)', () => {
  it('2 copies -> 2 printReceipt calls (cut each, beep first only) and 1 disconnect', async () => {
    const p = fake();
    await printViaPlugin(p, SAVED, ['A'], 2);
    expect(p.connectBluetoothPrinter).toHaveBeenCalledWith({ address: 'AA:BB' });
    expect(p.printReceipt).toHaveBeenCalledTimes(2);
    expect(p.printReceipt.mock.calls.map((c) => [c[0].cut, c[0].beep])).toEqual([[true, true], [true, false]]);
    expect(p.disconnectBluetoothPrinter).toHaveBeenCalledTimes(1);
  });

  it('2nd copy throws -> printLines says "failed" and the disconnect still ran', async () => {
    let n = 0;
    const p = fake({ printReceipt: vi.fn<ThermalPrinterPlugin['printReceipt']>(async () => { if (++n === 2) throw new Error('boom'); }) });
    installPrinterBridge(async () => SAVED);
    expect(await printLines(['A'], { copies: 2 })).toBe('failed');
    expect(p.disconnectBluetoothPrinter).toHaveBeenCalledTimes(1);
  });

  it('no saved address -> failed, no connect call', async () => {
    const p = fake();
    installPrinterBridge(async () => null);
    expect(await printLines(['A'], { copies: 1 })).toBe('failed');
    expect(p.connectBluetoothPrinter).not.toHaveBeenCalled();
    expect(p.disconnectBluetoothPrinter).not.toHaveBeenCalled();
  });

  it('₱ becomes P in the native path only', async () => {
    const p = fake();
    await printViaPlugin(p, SAVED, ['TOTAL ₱10.00'], 1);
    expect(p.printReceipt.mock.calls[0]?.[0].text).toBe('TOTAL P10.00');
    expect(p.printReceipt.mock.calls[0]?.[0]).toMatchObject({ widthMm: 58, encoding: 'CP437', font: 'normal' });
    expect(forPrinter('₱1')).toBe('P1');
  });

  it("printerMode() is 'browser' without the plugin and 'plugin' once installed", () => {
    expect(installPrinterBridge()).toBe(false);
    expect(printerMode()).toBe('browser');
    fake();
    expect(installPrinterBridge()).toBe(true);
    expect(printerMode()).toBe('plugin');
  });

  it('a connect failure reads in plain words', () => {
    expect(printerErrorMessage(new Error('Printer not connected.'))).toBe("Can't reach the printer. Is it on and paired in Android Bluetooth settings?");
  });

  it('test slip fits the chosen width', () => {
    for (const [width, cols] of [[58, 32], [80, 48]] as const) {
      const lines = testSlipLines('SHAREAT', '19 Nov 2026 10:00', width, 'normal');
      expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(cols);
    }
  });
});
