import { describe, expect, it } from 'vitest';
import { stripImageMetadata, stripJpegMetadata } from '../src/exif';

/**
 * T-141 §6 rule 3 — a receipt photo must not carry the photographer's location.
 *
 * ⭐ The tests build JPEGs byte by byte rather than using fixtures, because the thing under test
 * IS the byte layout. A fixture would prove the stripper works on one phone's output; this proves
 * it works on the format.
 */

/** `0xFF <marker> <len hi> <len lo> <payload…>` */
function segment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A minimal but structurally real JPEG. */
function jpeg(...segments: number[][]): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, // SOI
    ...segments.flat(),
    0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0, // SOS + a tiny header
    0x12, 0x34, 0x56, 0x78, // "image data"
    0xff, 0xd9, // EOI
  ]);
}

const JFIF = segment(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const EXIF = segment(0xe1, [...ascii('Exif\0'), 0, ...ascii('GPS-LAT-14.1-LON-121.0')]);
const XMP = segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'));
const IPTC = segment(0xed, ascii('Photoshop 3.0\0somewhere'));
const COMMENT = segment(0xfe, ascii('a harmless comment'));

describe('stripJpegMetadata', () => {
  it('⭐ removes the EXIF block, and the GPS bytes are gone from the output', () => {
    const withExif = jpeg(JFIF, EXIF);
    const r = stripJpegMetadata(withExif);

    expect(r.handled).toBe(true);
    expect(r.removed).toBe(1);
    // The literal check that matters: the coordinates are not in the bytes any more.
    const text = String.fromCharCode(...r.bytes);
    expect(text).not.toContain('GPS-LAT');
    expect(withExif.length).toBeGreaterThan(r.bytes.length);
  });

  it('⚠️ keeps JFIF — dropping every APP segment would break decoders', () => {
    const r = stripJpegMetadata(jpeg(JFIF, EXIF));
    // APP0/JFIF carries density and thumbnail info some decoders rely on. It is not metadata
    // about the photographer, so it stays.
    expect(String.fromCharCode(...r.bytes)).toContain('JFIF');
  });

  it('removes XMP and IPTC too — both can carry location', () => {
    const r = stripJpegMetadata(jpeg(JFIF, EXIF, XMP, IPTC));
    expect(r.removed).toBe(3);
    const text = String.fromCharCode(...r.bytes);
    expect(text).not.toContain('ns.adobe.com');
    expect(text).not.toContain('Photoshop');
  });

  it('⭐ leaves the image data byte-for-byte intact', () => {
    const r = stripJpegMetadata(jpeg(JFIF, EXIF));
    // ⚠️ This is why the segment is dropped rather than the file re-encoded: recompressing would
    // lose detail on the one thing that matters — small printed figures on a receipt.
    const tail = Array.from(r.bytes.slice(-6));
    expect(tail).toEqual([0x12, 0x34, 0x56, 0x78, 0xff, 0xd9]);
  });

  it('a clean photo passes through unchanged', () => {
    const clean = jpeg(JFIF, COMMENT);
    const r = stripJpegMetadata(clean);
    expect(r.removed).toBe(0);
    expect(Array.from(r.bytes)).toEqual(Array.from(clean));
  });

  it('⛔ is not fooled by 0xFF bytes inside the image data', () => {
    // Entropy-coded data is full of 0xFF00 pairs. A stripper that kept scanning past SOS looking
    // for markers would corrupt the picture — so everything after SOS is copied verbatim.
    const withMarkerish = Uint8Array.from([
      0xff, 0xd8, ...JFIF, ...EXIF,
      0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0,
      0xff, 0x00, 0xff, 0xe1, 0x00, 0x04, 0xaa, // looks like an APP1 but is image data
      0xff, 0xd9,
    ]);
    const r = stripJpegMetadata(withMarkerish);
    expect(r.removed).toBe(1); // the real APP1 only
    // The marker-shaped bytes after SOS survive untouched.
    expect(Array.from(r.bytes.slice(-9))).toEqual([
      0xff, 0x00, 0xff, 0xe1, 0x00, 0x04, 0xaa, 0xff, 0xd9,
    ]);
  });

  it('⚠️ says so rather than guessing when the input is not a JPEG', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const r = stripJpegMetadata(png);
    expect(r.handled).toBe(false);
    expect(Array.from(r.bytes)).toEqual(Array.from(png));
  });
});

describe('stripImageMetadata', () => {
  it('handles JPEG and passes other types through', () => {
    expect(stripImageMetadata(jpeg(JFIF, EXIF), 'image/jpeg').removed).toBe(1);
    // ⚠️ A STATED GAP, not an oversight: PNG and WebP can carry eXIf, but phone cameras produce
    // JPEG overwhelmingly and a half-written PNG parser is a worse risk than a documented one.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    expect(stripImageMetadata(png, 'image/png').handled).toBe(false);
  });
});
