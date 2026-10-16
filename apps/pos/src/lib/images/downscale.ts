/**
 * Client-side image downscaling, shared by the QR wallet and payment-proof
 * capture flows.
 *
 * Both flows receive a photo straight from the OS camera app, which on a modern
 * phone means a 3–8 MB JPEG at around 4000×3000. That is far too large to
 * upload over a till's connection, and — counter-intuitively — too large to
 * decode reliably: a QR's finder patterns end up tiny relative to the frame.
 *
 * EXIF ORIENTATION IS NOT OPTIONAL. Phone cameras record portrait shots as
 * landscape pixels plus an orientation flag. Drawing the raw bitmap without
 * honouring that flag yields a sideways image, which defeats both the QR
 * decoder and the OCR. `createImageBitmap(..., { imageOrientation: "from-image" })`
 * applies it; the <img> fallback below gets it for free because the browser
 * applies EXIF when decoding into an element.
 */

export type DownscaleOptions = {
  /** Target length of the longest edge, in pixels. */
  maxEdge: number;
  /** JPEG quality, 0–1. Defaults to 0.9. */
  quality?: number;
  /** Output MIME type. Defaults to image/jpeg. */
  type?: string;
};

export type DownscaleResult = {
  blob: Blob;
  width: number;
  height: number;
};

/** Long-edge target for QR decoding — big enough to keep finder patterns sharp. */
export const QR_DECODE_MAX_EDGE = 1600;
/**
 * Long-edge target for proof photos sent to the vision model. 1024 keeps the
 * image-token cost near ₱0.05/call while staying legible for OCR.
 */
export const PROOF_UPLOAD_MAX_EDGE = 1024;

type Drawable = ImageBitmap | HTMLImageElement;

function dimensionsOf(source: Drawable): { width: number; height: number } {
  return source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.width, height: source.height };
}

/**
 * Decodes a Blob into something drawable, with EXIF orientation applied.
 *
 * Prefers createImageBitmap (no DOM, works off the main thread) and falls back
 * to an <img> + object URL where the orientation option is unsupported.
 */
export async function loadDrawable(source: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(source, { imageOrientation: "from-image" });
    } catch {
      // Older Safari/WebView rejects the options bag — fall through.
    }
  }

  const url = URL.createObjectURL(source);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not decode the selected image."));
      image.src = url;
    });
  } finally {
    // Safe to revoke once decoding has settled; the element keeps its bitmap.
    URL.revokeObjectURL(url);
  }
}

/** Releases an ImageBitmap's memory. No-op for <img> elements. */
export function releaseDrawable(source: Drawable): void {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) source.close();
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: AnyCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  // willReadFrequently matters: the QR ladder calls getImageData repeatedly.
  const ctx = (canvas as HTMLCanvasElement).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D context unavailable.");
  return ctx as CanvasRenderingContext2D;
}

async function canvasToBlob(canvas: AnyCanvas, type: string, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas === "function" && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas encoding failed."))),
      type,
      quality,
    );
  });
}

/** Scale factor that fits the longest edge into maxEdge. Never upscales. */
function scaleFor(width: number, height: number, maxEdge: number): number {
  const longest = Math.max(width, height);
  return longest <= maxEdge ? 1 : maxEdge / longest;
}

/**
 * Draws a drawable into a canvas at the given long-edge target and returns the
 * raw pixels. Used by the QR decode ladder.
 */
export function drawToImageData(source: Drawable, maxEdge: number): ImageData {
  const { width, height } = dimensionsOf(source);
  const scale = scaleFor(width, height, maxEdge);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = createCanvas(targetWidth, targetHeight);
  const ctx = context2d(canvas);
  ctx.drawImage(source as CanvasImageSource, 0, 0, targetWidth, targetHeight);
  return ctx.getImageData(0, 0, targetWidth, targetHeight);
}

/**
 * Downscales an image file, honouring EXIF orientation.
 *
 * Returns the original bytes untouched when the image is already within
 * `maxEdge` and is already a JPEG — re-encoding a small image only loses
 * quality and wastes time.
 */
export async function downscaleImage(
  file: Blob,
  { maxEdge, quality = 0.9, type = "image/jpeg" }: DownscaleOptions,
): Promise<DownscaleResult> {
  const source = await loadDrawable(file);
  try {
    const { width, height } = dimensionsOf(source);
    const scale = scaleFor(width, height, maxEdge);

    if (scale === 1 && file.type === type) {
      return { blob: file, width, height };
    }

    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = createCanvas(targetWidth, targetHeight);
    const ctx = context2d(canvas);
    ctx.drawImage(source as CanvasImageSource, 0, 0, targetWidth, targetHeight);

    const blob = await canvasToBlob(canvas, type, quality);
    return { blob, width: targetWidth, height: targetHeight };
  } finally {
    releaseDrawable(source);
  }
}
