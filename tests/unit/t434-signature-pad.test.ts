import { describe, expect, it, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T-434 TESTER, case 19 - the signature pad hands the server action a PNG Blob, never a data URL.
 *
 * CONTRACT (BUILDER): `apps/erp/src/components/signature-pad-export.ts` exports, with no React or DOM import,
 *   exportSignaturePng(canvas: { toBlob(cb: (b: Blob | null) => void, type?: string): void; toDataURL?: unknown }): Promise<Blob>
 *     - calls canvas.toBlob(..., 'image/png'); NEVER calls toDataURL; rejects when toBlob yields null
 *   signatureFormData(blob: Blob, personId: string): FormData
 *     - field `signature` holds the Blob/File (type image/png); field `personId`; no field value is a `data:` string
 * and `apps/erp/src/components/SignaturePad.tsx` is a 'use client' component that uses exportSignaturePng.
 * RED reason before the build: the module and component do not exist.
 */
const root = join(__dirname, '..', '..');
const pngBlob = () => new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

async function load() {
  return (await import('../../apps/erp/src/components/signature-pad-export')) as {
    exportSignaturePng: (c: unknown) => Promise<Blob>;
    signatureFormData: (b: Blob, personId: string) => FormData;
  };
}

describe('19. signature pad export', () => {
  it('exports a PNG Blob through toBlob and never touches toDataURL', async () => {
    const { exportSignaturePng } = await load();
    const toDataURL = vi.fn(() => 'data:image/png;base64,AAAA');
    const toBlob = vi.fn((cb: (b: Blob | null) => void, type?: string) => cb(type === 'image/png' ? pngBlob() : null));
    const out = await exportSignaturePng({ toBlob, toDataURL });
    expect(out).toBeInstanceOf(Blob);
    expect(out.type).toBe('image/png');
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it('rejects when the canvas yields no blob (does not fall back to a data URL)', async () => {
    const { exportSignaturePng } = await load();
    const toDataURL = vi.fn(() => 'data:image/png;base64,AAAA');
    await expect(exportSignaturePng({ toBlob: (cb: (b: Blob | null) => void) => cb(null), toDataURL })).rejects.toBeDefined();
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it('the form sent to the action carries the PNG as a file part and no data: string', async () => {
    const { signatureFormData } = await load();
    const fd = signatureFormData(pngBlob(), '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee');
    const part = fd.get('signature');
    expect(part).toBeInstanceOf(Blob);
    expect((part as Blob).type).toBe('image/png');
    expect(fd.get('personId')).toBe('0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee');
    for (const [, v] of fd.entries()) if (typeof v === 'string') expect(v.startsWith('data:')).toBe(false);
  });

  it('the component file exists, is client-side, uses the exporter and has no toDataURL', () => {
    const p = join(root, 'apps/erp/src/components/SignaturePad.tsx');
    expect(existsSync(p), 'SignaturePad.tsx does not exist').toBe(true);
    const src = readFileSync(p, 'utf8');
    expect(src).toMatch(/^['"]use client['"]/m);
    expect(src).toContain('exportSignaturePng');
    expect(src).not.toMatch(/toDataURL/);
  });
});
