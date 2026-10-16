/**
 * Decodes a QR code out of a still photo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the ONLY module allowed to import the QR decoder.
 * ─────────────────────────────────────────────────────────────────────────────
 * jsQR has not shipped a release since 2018, so the version is pinned exactly
 * ("jsqr": "1.4.0", no caret). Keeping the import behind this one boundary means
 * replacing the decoder later is a one-file change.
 *
 * WHY A STILL AND NOT A VIDEO STREAM: the capture flow deliberately takes a
 * photo first and parses afterwards. That lets the OS camera app do the
 * focusing, exposure and torch — all of which raise decode success far more
 * than any in-app scanning loop would — and it costs no camera permission.
 *
 * WHY A LADDER: one pass over a raw 4000×3000 phone photo fails often. The
 * finder patterns are tiny relative to the frame and jsQR's binarizer struggles
 * with uneven lighting on a glossy printed QR. The ladder below is modelled on
 * the Bills Reminder Android app's QrAnalyzer, which solved the same problem
 * with ZXing: try the middle of the frame before the whole of it, and retry
 * rotated because some captures arrive sideways.
 */

import {
  QR_DECODE_MAX_EDGE,
  drawToImageData,
  loadDrawable,
  releaseDrawable,
} from "@/lib/images/downscale";

export type QrDecodeResult = {
  payload: string;
  /** Which ladder rung produced the hit — useful when diagnosing bad captures. */
  via: string;
};

/**
 * Long-edge targets, largest first. A big image carries more detail; a smaller
 * one gives the binarizer an easier time. Trying both costs milliseconds.
 */
const SCALES = [QR_DECODE_MAX_EDGE, 1024, 640];

/** Fraction of the frame kept by the centre crop — where the QR actually is. */
const CENTRE_CROP = 2 / 3;

type JsQrModule = typeof import("jsqr");
let jsQrPromise: Promise<JsQrModule> | null = null;

/** Loads the decoder once, lazily, so it never lands in the initial bundle. */
async function loadJsQr(): Promise<JsQrModule["default"]> {
  if (!jsQrPromise) jsQrPromise = import("jsqr");
  const mod = await jsQrPromise;
  return mod.default ?? (mod as unknown as JsQrModule["default"]);
}

/** Crops the centre of an ImageData. Returns the input when the crop is a no-op. */
function centreCrop(image: ImageData): ImageData | null {
  const cropWidth = Math.round(image.width * CENTRE_CROP);
  const cropHeight = Math.round(image.height * CENTRE_CROP);
  if (cropWidth < 32 || cropHeight < 32) return null;

  const left = Math.round((image.width - cropWidth) / 2);
  const top = Math.round((image.height - cropHeight) / 2);
  const out = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  for (let row = 0; row < cropHeight; row++) {
    const sourceStart = ((top + row) * image.width + left) * 4;
    out.set(image.data.subarray(sourceStart, sourceStart + cropWidth * 4), row * cropWidth * 4);
  }
  return new ImageData(out, cropWidth, cropHeight);
}

/** Rotates an ImageData 90° clockwise. */
function rotate90(image: ImageData): ImageData {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      // (x, y) → (height - 1 - y, x) in the rotated frame, whose width is `height`.
      const to = (x * height + (height - 1 - y)) * 4;
      out[to] = data[from];
      out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2];
      out[to + 3] = data[from + 3];
    }
  }
  return new ImageData(out, height, width);
}

/**
 * Decodes a single live-preview frame.
 *
 * Deliberately cheaper than the still ladder: a scanner gets ~10 frames a
 * second, so a frame that misses costs nothing and the next one is already on
 * its way. Spending 12 passes on a frame would drop the frame rate and make
 * scanning FEEL worse while finding nothing a later frame wouldn't.
 *
 * Centre first (that is where the aiming box is), then the full frame.
 */
export async function decodeQrFromFrame(frame: ImageData): Promise<QrDecodeResult | null> {
  const decode = await loadJsQr();
  return (
    attempt(decode, centreCrop(frame), "centre-frame") ?? attempt(decode, frame, "full-frame")
  );
}

function attempt(
  decode: JsQrModule["default"],
  image: ImageData | null,
  via: string,
): QrDecodeResult | null {
  if (!image) return null;
  try {
    const found = decode(image.data, image.width, image.height, {
      // jsQR's equivalent of ZXing's TRY_HARDER: also try an inverted image, so
      // a light-on-dark QR (some bank apps render these) still decodes.
      inversionAttempts: "attemptBoth",
    });
    const payload = found?.data?.trim();
    return payload ? { payload, via } : null;
  } catch {
    // A bad frame must never take down the capture flow.
    return null;
  }
}

/**
 * Runs the ladder over one photo. Returns the first payload found, or null.
 *
 * Callers must treat null as "save the photo anyway" — a failed decode is a
 * degraded result, never a lost capture.
 */
export async function decodeQrFromImage(file: Blob): Promise<QrDecodeResult | null> {
  const decode = await loadJsQr();
  const source = await loadDrawable(file);

  try {
    for (const maxEdge of SCALES) {
      const full = drawToImageData(source, maxEdge);

      // Centre first — it is both the likeliest location and the cheapest pass.
      const hit =
        attempt(decode, centreCrop(full), `centre@${maxEdge}`) ??
        attempt(decode, full, `full@${maxEdge}`);
      if (hit) return hit;

      // Some captures arrive sideways; retry this scale rotated before
      // dropping to a smaller one.
      const rotated = rotate90(full);
      const rotatedHit =
        attempt(decode, centreCrop(rotated), `centre-rot@${maxEdge}`) ??
        attempt(decode, rotated, `full-rot@${maxEdge}`);
      if (rotatedHit) return rotatedHit;
    }
    return null;
  } finally {
    releaseDrawable(source);
  }
}
