'use client';
/**
 * T-532 S1 — choose and test the Bluetooth printer. Shows only when the Android shell's plugin is present;
 * in a browser it says printing uses the print dialog. The choice is saved on THIS device (device store `meta`), not on the server.
 */
import { useEffect, useState } from 'react';
import { Banner, Button } from '@/components/ui';
import {
  installPrinterBridge,
  loadSavedPrinter,
  printViaPlugin,
  printerErrorMessage,
  savePrinter,
  thermalPlugin,
  type BondedPrinter,
  type SavedPrinter,
} from '@/lib/pos-print/native';
import { testSlipLines } from '@/lib/pos-print/test-slip';

const choice = 'min-h-12 rounded-lg border px-4 py-2 text-left';

export function PrinterScreen() {
  const [hasPlugin, setHasPlugin] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<SavedPrinter | null>(null);
  const [devices, setDevices] = useState<BondedPrinter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => {
    const plugin = thermalPlugin();
    if (!plugin) return;
    try {
      setDevices((await plugin.listBluetoothPrinters()).devices);
      setError(null);
    } catch (e) {
      setError(printerErrorMessage(e));
    }
  };

  useEffect(() => {
    installPrinterBridge();
    const present = Boolean(thermalPlugin());
    setHasPlugin(present);
    if (!present) return;
    void loadSavedPrinter().then(setSaved, () => setSaved(null));
    void refresh();
  }, []);

  const persist = async (next: SavedPrinter) => {
    setSaved(next);
    try {
      await savePrinter(next);
      setNote('Saved on this tablet.');
    } catch {
      setError('Could not save the printer on this tablet.');
    }
  };

  const pick = (d: BondedPrinter) => persist({ address: d.address, name: d.name, widthMm: saved?.widthMm ?? 58, font: saved?.font ?? 'normal' });

  const test = async () => {
    setError(null);
    setNote(null);
    if (!saved) return setError('No printer chosen yet. Pick one above.');
    const time = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
    const lines = testSlipLines('SharEat POS', time, saved.widthMm, saved.font);
    const plugin = thermalPlugin();
    if (!plugin) return;
    try {
      await printViaPlugin(plugin, saved, lines, 1); // direct, so the real reason shows in plain words
      setNote('Test slip sent.');
    } catch (e) {
      setError(printerErrorMessage(e));
    }
  };

  if (hasPlugin === null) return null;
  if (!hasPlugin) {
    return <Banner tone="info">Printing from this browser uses the print dialog.</Banner>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Printer</h1>
      <p className="text-sm">Pair the printer in Android Bluetooth settings first, then pick it here.</p>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {note ? <Banner tone="info">{note}</Banner> : null}
      <div className="space-y-2">
        {devices.length === 0 ? <p className="text-sm">No paired printers found.</p> : null}
        {devices.map((d) => (
          <button key={d.address} type="button" className={`${choice} w-full ${saved?.address === d.address ? 'border-brand font-semibold' : ''}`} onClick={() => void pick(d)}>
            {d.name} {saved?.address === d.address ? '(chosen)' : ''}
          </button>
        ))}
        <Button variant="secondary" icon={null} onClick={() => void refresh()}>
          Refresh list
        </Button>
      </div>
      {saved ? (
        <div className="flex flex-wrap gap-2">
          {([58, 80] as const).map((w) => (
            <button key={w} type="button" className={`${choice} ${saved.widthMm === w ? 'border-brand font-semibold' : ''}`} onClick={() => void persist({ ...saved, widthMm: w })}>
              {w} mm paper
            </button>
          ))}
          {(['normal', 'small'] as const).map((f) => (
            <button key={f} type="button" className={`${choice} ${saved.font === f ? 'border-brand font-semibold' : ''}`} onClick={() => void persist({ ...saved, font: f })}>
              {f === 'normal' ? 'Normal font' : 'Small font'}
            </button>
          ))}
        </div>
      ) : null}
      <Button icon={null} onClick={() => void test()}>
        Print test slip
      </Button>
    </div>
  );
}
