/**
 * Strip camera metadata from an uploaded image. T-141 §6 rule 3.
 *
 * ## ⚠️ Why a receipt photo is a privacy question at all
 *
 * A phone photo of a supplier invoice carries an **EXIF block**: GPS coordinates, the device make,
 * model and serial, and the exact capture time. Nobody asked staff for their location, ADR-007
 * would have to account for it, and it would sit in the books for years attached to a document
 * whose only job is to prove what was bought.
 *
 * **The photo is evidence of a purchase. It is not evidence of where an employee was.**
 *
 * ## ⭐ Why this is hand-written rather than a dependency
 *
 * Re-encoding through an image library (`sharp`) would strip it — but `sharp` is a **native
 * module**, and this repo already carries a landmine about native deps needing
 * `serverExternalPackages` to survive Next's bundling. Dropping a JPEG segment needs no decoding
 * at all: JPEG is a flat sequence of marker segments, and EXIF lives in exactly one of them.
 *
 * ⚠️ **Re-encoding would also be worse**, not just heavier: it would recompress the image and lose
 * detail on the one thing that matters — small printed figures on a receipt.
 */

/** Every JPEG starts with SOI. */
const SOI = 0xffd8;
/** Start of Scan — after this it is entropy-coded image data, not segments. */
const SOS = 0xffda;
/**
 * ⚠️ APP1 usually holds EXIF but can hold XMP instead; APP0 is JFIF and is load-bearing. Dropping
 * every APP segment would break some decoders, so this drops only the ones that carry metadata we
 * do not want, identified by their payload.
 */
const APP1 = 0xffe1;
const APP13 = 0xffed; // Photoshop IRB — can carry IPTC location data

export interface StripResult {
  bytes: Uint8Array;
  /** How many metadata segments were removed. Zero is a normal, healthy outcome. */
  removed: number;
  /** False when the input is not a JPEG — see `stripImageMetadata`'s note. */
  handled: boolean;
}

function startsWith(buf: Uint8Array, at: number, ascii: string): boolean {
  for (let i = 0; i < ascii.length; i++) {
    if (buf[at + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Removes EXIF/XMP/IPTC segments from a JPEG, leaving the image data untouched.
 *
 * ⚠️ Returns `handled: false` for anything that is not a JPEG. The caller decides what to do with
 * that — see `stripImageMetadata`.
 */
export function stripJpegMetadata(input: Uint8Array): StripResult {
  if (input.length < 4 || ((input[0]! << 8) | input[1]!) !== SOI) {
    return { bytes: input, removed: 0, handled: false };
  }

  const out: number[] = [0xff, 0xd8];
  let i = 2;
  let removed = 0;

  while (i < input.length - 1) {
    // Segments are 0xFF <marker>. Padding 0xFF bytes are legal between segments.
    if (input[i] !== 0xff) break;
    let marker = input[i + 1]!;
    while (marker === 0xff && i + 2 < input.length) {
      i += 1;
      marker = input[i + 1]!;
    }
    const full = 0xff00 | marker;

    // ⭐ Everything from SOS onward is image data. Copy the remainder verbatim and stop parsing —
    // scanning entropy-coded bytes for markers is how a "clever" stripper corrupts a photo.
    if (full === SOS) {
      for (let k = i; k < input.length; k++) out.push(input[k]!);
      return { bytes: Uint8Array.from(out), removed, handled: true };
    }

    // Standalone markers carry no length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      out.push(0xff, marker);
      i += 2;
      continue;
    }

    if (i + 4 > input.length) break;
    const length = (input[i + 2]! << 8) | input[i + 3]!;
    if (length < 2 || i + 2 + length > input.length) break;

    const payloadAt = i + 4;
    const isExif = full === APP1 && startsWith(input, payloadAt, 'Exif\0');
    const isXmp = full === APP1 && startsWith(input, payloadAt, 'http://ns.adobe.com/xap');
    const isIptc = full === APP13 && startsWith(input, payloadAt, 'Photoshop');

    if (isExif || isXmp || isIptc) {
      removed += 1;
    } else {
      for (let k = i; k < i + 2 + length; k++) out.push(input[k]!);
    }
    i += 2 + length;
  }

  return { bytes: Uint8Array.from(out), removed, handled: true };
}

/**
 * The broker's entry point: strip what can be stripped, and be honest about what cannot.
 *
 * ⚠️ **PNG and WebP pass through unchanged, and that is a stated gap rather than an oversight.**
 * Both *can* carry `eXIf` chunks, but phone cameras produce JPEG overwhelmingly, and a
 * half-implemented PNG parser is a worse risk than a documented one. ⛔ If a camera path ever
 * starts producing PNG, this needs revisiting — the comment is here so that is a decision rather
 * than a discovery.
 */
export function stripImageMetadata(
  bytes: Uint8Array,
  contentType: string,
): StripResult {
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') {
    return stripJpegMetadata(bytes);
  }
  return { bytes, removed: 0, handled: false };
}
