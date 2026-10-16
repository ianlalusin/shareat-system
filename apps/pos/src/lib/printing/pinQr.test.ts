import { describe, expect, it } from 'vitest';
import { parsePinQrMode, renderPinQr, DEFAULT_PIN_QR_MODE, PIN_QR_NATIVE_DOTS } from './pinQr';

describe('parsePinQrMode', () => {
  it('keeps every known mode', () => {
    expect(parsePinQrMode('raster-trim')).toBe('raster-trim');
    expect(parsePinQrMode('raster-margin')).toBe('raster-margin');
    expect(parsePinQrMode('raster-full')).toBe('raster-full');
    expect(parsePinQrMode('native')).toBe('native');
  });

  it('falls back to the printer-drawn QR for missing or unknown values', () => {
    expect(DEFAULT_PIN_QR_MODE).toBe('native');
    expect(parsePinQrMode(null)).toBe('native');
    expect(parsePinQrMode('')).toBe('native');
    expect(parsePinQrMode('bogus')).toBe('native');
  });
});

// PNG IHDR: width and height are big-endian uint32 at bytes 16 and 20.
function pngSize(base64: string) {
  const buf = Buffer.from(base64, 'base64');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('renderPinQr', () => {
  // A real join URL is ~139-162 chars (base64url JSON payload + 16-byte HMAC).
  const joinUrl = `https://customer.shareat.net/join?t=${'a'.repeat(84)}.${'b'.repeat(22)}`;

  it('renders 5 printer dots per module with a 1-module quiet zone', async () => {
    const { qrImageBase64, qrModules } = await renderPinQr(joinUrl);
    const png = pngSize(qrImageBase64);
    expect(qrModules).toBe(49); // version 8
    expect(png.width).toBe((49 + 2) * 5);
    expect(png.height).toBe((49 + 2) * 5);
  });

  it('prints the printer-drawn QR at 5 dots and it fits 58mm paper (384 dots)', async () => {
    const { qrModules } = await renderPinQr(`${joinUrl}${'c'.repeat(23)}`);
    expect(PIN_QR_NATIVE_DOTS).toBe(5);
    expect(qrModules).toBe(53); // version 9, the longest join URL
    expect(qrModules * PIN_QR_NATIVE_DOTS).toBeLessThanOrEqual(384);
  });

  it('fits 58mm paper (384 dots) for the longest join URLs', async () => {
    const { qrImageBase64 } = await renderPinQr(`${joinUrl}${'c'.repeat(23)}`);
    const png = pngSize(qrImageBase64);
    expect(png.width).toBeLessThanOrEqual(384);
  });
});
