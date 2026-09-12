/**
 * T-296 — the DECISIONS behind photo compression, with no browser in them.
 *
 * **Ian, 2026-09-12:** *"i want every uploaded photo accross the app to not exceed 1mb so compress
 * it before uploading."*
 *
 * ## ⭐ Why this file exists separately from `PhotoInput.tsx`
 *
 * Canvas, `createImageBitmap` and `DataTransfer` cannot run in a node test. The *rules* — which
 * dimension to try, which quality, when to stop, when to give up — are the part that can be wrong
 * in a way nobody notices, so they live here as pure functions and are executed by
 * `tests/unit/photo-compression.test.ts`. The component does the drawing and nothing else.
 *
 * ⚠️ This mirrors the split `sidebar-state.ts` already uses for the same reason: *"framework-free,
 * so the unit test never needs this file's `usePathname`/React Client Component weight at all."*
 */

/**
 * ⭐ What the BROWSER aims for — deliberately below the server's ceiling.
 *
 * The gap is not slack. A marginal encode landing at 1,040,000 bytes would be refused by the
 * server, whose message is about bytes rather than about what the person should do next. Aiming
 * under the line means the layer that can explain itself is the one that decides.
 */
export const PHOTO_TARGET_BYTES = 950 * 1024;

/**
 * ⛔ The long edge, in order. **Dimensions are the first lever and quality is the second**, because
 * that is the answer to `packages/core/src/exif.ts:20`'s objection — *"it would recompress the
 * image and lose detail on the one thing that matters, small printed figures on a receipt."*
 *
 * Detail loss on glyph edges comes from crushing quality; a 4000 px photo of a receipt spends
 * almost all of its pixels on paper texture. 2000 px keeps printed figures legible on every
 * receipt tried by hand.
 *
 * ⚠️ 1280 is a FLOOR, not a last resort to be extended. Below it a receipt stops being evidence,
 * and uploading something unreadable to satisfy a size rule defeats the control the photo exists
 * for. Past the floor the form refuses and says so.
 */
export const EDGE_LADDER = [2000, 1600, 1280] as const;

/**
 * Quality steps tried at each edge. Stops at the first pass under target, so a photo that fits at
 * 0.85 is never re-encoded at 0.75.
 */
export const QUALITY_LADDER = [0.85, 0.75, 0.65, 0.55] as const;

/** ⭐ JPEG, always. WebP is smaller but Safari's encoder support has been uneven, and a receipt
 *  that fails to encode on the reviewer's phone is worse than one that is 40 KB larger. */
export const OUTPUT_TYPE = 'image/jpeg';

/** Content types this compresses. ⛔ PDFs are NOT here — they cannot be canvas-re-encoded, and the
 *  rule Ian stated is about photos. A PDF passes through and keeps its per-purpose limit. */
const COMPRESSIBLE = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

export function isCompressibleImage(contentType: string): boolean {
  return COMPRESSIBLE.includes(contentType.toLowerCase());
}

/**
 * The (edge, quality) pairs to try, in order. Exhausting this list without getting under target is
 * the refusal case.
 *
 * ⚠️ Edge is the OUTER loop: dropping to 1600 px at q0.85 preserves more legible text than staying
 * at 2000 px and crushing to q0.55, even when the two produce the same byte count.
 */
export function compressionAttempts(): { edge: number; quality: number }[] {
  const attempts: { edge: number; quality: number }[] = [];
  for (const edge of EDGE_LADDER) {
    for (const quality of QUALITY_LADDER) attempts.push({ edge, quality });
  }
  return attempts;
}

/**
 * Target pixel dimensions for a source of `width`×`height` constrained to `edge` on its long side.
 *
 * ⛔ **Never upscales.** A 900 px photo asked to fit a 2000 px edge stays 900 px — enlarging adds
 * bytes and no information, which is the opposite of the point.
 */
export function scaleToEdge(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const ratio = edge / longest;
  // ⚠️ `Math.max(1, …)` — a 4000×3 panorama would otherwise round its short side to 0 and produce
  //    a zero-area canvas, which draws nothing and encodes to a few bytes that look like success.
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * ⛔ Mobile Safari refuses to allocate a canvas past roughly 16.7 MP and returns a BLANK one rather
 * than throwing — a silent failure that encodes to a small file and looks like excellent
 * compression. Anything above this must be downscaled before the first draw, never after.
 */
export const MAX_CANVAS_PIXELS = 16_777_216;

export function needsPreScale(width: number, height: number): boolean {
  return width * height > MAX_CANVAS_PIXELS;
}

/** Human-readable size, for the before/after the component shows. ⭐ Silent mutation of someone's
 *  file is how trust in an upload control is lost, so the change is always visible. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
