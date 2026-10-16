'use client';

// Minimal WebUSB ESC/POS sender.
// NOTE: WebUSB requires HTTPS (or localhost) and user gesture to request the device.

export type WebUsbPrinterState = {
  vendorId?: number;
  productId?: number;
};

function enc(text: string) {
  return new TextEncoder().encode(text);
}

function hexBytes(hex: string) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function escposCutFull() {
  // GS V 0  => 1D 56 00
  return hexBytes('1D5600');
}

export async function webusbRequestPrinter(filters: Array<{ vendorId?: number; productId?: number }> = []) {
  if (!('usb' in navigator)) throw new Error('WebUSB is not supported in this browser.');
  // user gesture required
  const device = await (navigator as any).usb.requestDevice({ filters });
  return device as any;
}

export async function webusbPrint(options: {
  device?: any;
  text: string;
  cut?: boolean;
  interfaceNumber?: number; // optional override
  endpointNumber?: number;  // optional override
}) {
  if (!('usb' in navigator)) throw new Error('WebUSB is not supported in this browser.');
  const { device: provided, text, cut = true } = options;

  const device = provided ?? (await webusbRequestPrinter());
  await device.open();
  if (device.configuration == null) await device.selectConfiguration(1);

  // Pick first interface with an OUT endpoint if none provided.
  let ifaceNum = options.interfaceNumber;
  let epNum = options.endpointNumber;

  if (ifaceNum == null || epNum == null) {
    const cfg = device.configuration!;
    for (const iface of cfg.interfaces) {
      for (const alt of iface.alternates) {
        const outEp = alt.endpoints.find((e: any) => e.direction === 'out');
        if (outEp) {
          ifaceNum = iface.interfaceNumber;
          epNum = outEp.endpointNumber;
          break;
        }
      }
      if (ifaceNum != null && epNum != null) break;
    }
  }

  if (ifaceNum == null || epNum == null) {
    await device.close();
    throw new Error('Could not find a writable USB interface/endpoint for this device.');
  }

  await device.claimInterface(ifaceNum);

  // ESC/POS payload: text + feeds + optional cut
  const feed = enc('\n\n\n\n');
  const payload = cut
    ? new Uint8Array([...enc(text), ...feed, ...escposCutFull()])
    : new Uint8Array([...enc(text), ...feed]);

  // Chunk writes to avoid transfer size issues
  const chunkSize = 1024;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    await device.transferOut(epNum, chunk);
  }

  try { await device.releaseInterface(ifaceNum); } catch (e) { console.warn("[USB] releaseInterface:", e); }
  try { await device.close(); } catch (e) { console.warn("[USB] close:", e); }

  return { vendorId: device.vendorId, productId: device.productId, interfaceNumber: ifaceNum, endpointNumber: epNum };
}
