# T-296 — every uploaded photo is compressed to under 1 MB, and the server enforces it

**Ian, 2026-09-12:** *"i want every uploaded photo accross the app to not exceed 1mb so compress it
before uploading."*

**Ian's ruling on how hard the cap is:** *compress in the browser **and** enforce server-side* — so
"no stored photo exceeds 1 MB" is a fact that can be proved from the database, not a tendency.

## ⚠️ The recorded objection, raised once and answered

`packages/core/src/exif.ts:20` argues against exactly this:

> ⚠️ **Re-encoding would also be worse**, not just heavier: it would recompress the image and lose
> detail on the one thing that matters — **small printed figures on a receipt**.

That concern is real and is not dismissed. A receipt photo exists so a human can verify *"right
supplier, right invoice data, right items, right price"* against it (Ian, 2026-08-28). An
unreadable photo is a worthless control.

⭐ **The answer is that detail loss comes from crushing QUALITY, not from downscaling DIMENSIONS.**
A 12 MP phone photo is ~4 MB at 4000 px on the long edge. Resizing to **2000 px** at quality 0.85
typically lands at 300–600 KB with printed figures still legible — the pixels spent on a receipt
photo are overwhelmingly spent on paper texture, not on glyph edges.

So the ladder is **dimensions first, quality second, with a floor on both**:

1. Downscale the long edge to `MAX_EDGE` (2000 px).
2. Encode JPEG at q0.85. Under target? Done.
3. Step quality down 0.85 → 0.75 → 0.65 → 0.55, stopping at the first pass under target.
4. Still over? Downscale to 1600 px, then 1280 px, repeating step 3.
5. Floor reached and still over target → **the form refuses and says why.** ⛔ It does not silently
   upload a mangled image, and it does not silently upload a large one.

## ⛔ What is NOT compressed

**PDFs.** `receipt_photo`, `memo_document` and `onboarding_document` all accept
`application/pdf`, and a PDF cannot be canvas-re-encoded. PDFs pass through untouched and keep
their existing per-purpose limit. **The 1 MB rule is about photos, which is what Ian asked for.**

⚠️ **This is also why `next.config.js`'s `bodySizeLimit: '26mb'` (T-282/DEF-317) stays as it is.**
A 25 MB onboarding PDF is still legal, so the framework bound must still clear it. Lowering it
because photos got smaller would re-create DEF-317 for documents.

## The two halves

### 1. Client — `apps/erp/src/components/PhotoInput.tsx`

A client component wrapping `<input type="file">`. ⭐ **Not a new architectural pattern**: this app
already has a dozen `'use client'` components, and one of the three upload sites
(`inventory/deliveries/NewDeliveryForm.tsx`) is already one.

⚠️ **Four traps, all of which produce a working-looking result that is wrong:**

1. ⛔ **EXIF orientation.** Decoding with a plain `Image` and drawing to a canvas **loses rotation**,
   so every iPhone photo arrives sideways. Must use
   `createImageBitmap(file, { imageOrientation: 'from-image' })`.
2. ⛔ **Alpha → black.** A PNG with transparency encoded to JPEG gets a **black** background, not
   white. The canvas is filled white before drawing.
3. ⛔ **Canvas size limits.** Mobile Safari caps canvas area (~16.7 MP); a 48 MP photo silently
   yields a blank canvas. The first downscale must happen before any draw.
4. ⚠️ **Replacing the file.** The compressed blob is put back on the input via `DataTransfer` so the
   existing server actions need no change at all — they still read `formData.get('receiptPhoto')`.

⭐ **Progressive enhancement:** with JS off the original file is submitted and the server refuses it
if it is over the ceiling, with a message naming the size. The control is the server; the client is
the convenience.

⭐ **A visible before/after** — *"3.2 MB → 480 KB"* — is shown after compression. Silent mutation of
someone's file is how trust in an upload control is lost.

### 2. Server — one ceiling for every image, in `packages/domain/src/files/index.ts`

```ts
export const MAX_IMAGE_BYTES = 1024 * 1024; // exactly 1 MB
```

Applied in `runUpload` to **any `image/*` content type**, on top of the per-purpose limit.

⭐ **One global constant, not a per-purpose field.** Ian said *"across the app"*; a per-purpose
`maxImageBytes` is five places for the rule to drift between, and a new purpose would silently
default to whatever its author typed.

⚠️ **The client targets 950 KB, the server enforces 1024 KB.** The gap is deliberate: the client
aims under the line so a marginal encode is not rejected by the layer that cannot explain itself as
well. Both numbers are exported and the guard asserts `PHOTO_TARGET_BYTES < MAX_IMAGE_BYTES`.

## ⭐ Two things this fixes for free

1. **PNG and WebP lose their metadata too.** `stripImageMetadata` handles **only JPEG** and says so:
   *"PNG and WebP pass through unchanged, and that is a stated gap rather than an oversight."*
   A canvas re-encode drops all of it, so GPS in a PNG stops reaching storage.
2. **The EXIF stripper's own reason for existing gets stronger, not weaker.** It still runs, still
   handles the no-JS path, and is now the second layer rather than the only one (§15.11).

## Files this task may touch

- `apps/erp/src/components/PhotoInput.tsx` (new) + `photo-compression.ts` (new, pure)
- `apps/erp/src/app/ap/page.tsx` · `apps/erp/src/app/customers/[customerId]/page.tsx` ·
  `apps/erp/src/app/inventory/deliveries/NewDeliveryForm.tsx`
- `packages/domain/src/files/index.ts`
- `tests/unit/photo-compression.test.ts` (new)

## Definition of done

typecheck · unit green · the ceiling proven by a test that fails without it · **smoketested on 9008
with a real >1 MB photo, checking `stored_files.byte_size` is under 1 MB and the image is not
rotated** · the no-JS path refuses with a legible message.

---

# Browser verification — executed output, 2026-09-12

⭐ **None of this needed the dev server.** The compression is pure client-side, so it was run
directly in a browser tab. *"Needs a browser"* and *"needs the app running"* are different
requirements, and conflating them cost an hour of queueing.

## The ladder, on a synthetic 12 MP receipt (4000×3000, paper-texture noise + 25 lines of print)

```
original:   6.49 MB, 4000x3000
attempts:   ["2000x1500 q0.85 -> 700KB"]     ← ONE attempt. The quality ladder was never reached.
chosen:     2000x1500 @ q0.85, 716,678 bytes
reduction:  89%
```

⭐ **This is the answer to `packages/core/src/exif.ts:20`, made executable.** That comment feared
recompression destroying small printed figures. For an ordinary phone photo **the quality lever is
never pulled** — the first attempt at the highest quality already clears the target, because the
bytes are in the paper texture rather than in the glyphs. The objection is not disagreed with; the
mechanism it feared is simply not engaged.

## The three traps

| Trap | Result |
|---|---|
| **EXIF orientation** | 2400×1200 landscape + `Orientation=6` → decoded **1200×2400 portrait**. Applied. |
| **Alpha → black** | corner pixel `rgb(255,255,255)` with the white fill; **`rgb(0,0,0)` without it** |
| **DataTransfer swap** | `FormData.get('receiptPhoto')` returns the **compressed** file, 3072 KB → 480 KB, field name preserved, exactly one file on the input |

⭐ Trap 2 proved **both states** — the bug and the fix. That is the only version that shows the
white fill is doing work rather than being decoration.

## ⛔ Three things this does NOT prove, and none of them should be implied

1. ⚠️ **Safari is unverified.** Chrome now defaults `createImageBitmap` to `imageOrientation:
   'from-image'`, so decoding **without** the flag also produced 1200×2400. **Chrome therefore
   cannot prove the flag is load-bearing.** The honest claim is *"correct on Chrome, and explicitly
   correct rather than accidentally correct"*. Safari is where orientation historically broke and
   is where the flag actually earns its place — untested here.
2. ⚠️ **Legibility on a REAL receipt is a human judgement.** The synthetic fixture's text was 28 px
   at 4000 px wide, so it became 14 px at 2000 px. Real receipt text photographed at 12 MP is
   usually larger. ⛔ **Ian should spot-check one real receipt after this ships** — no amount of
   testing settles it, and claiming it from a generated image would be a false claim.
3. **End-to-end plumbing** — a real photo through `/ap` landing under 1 MB in
   `stored_files.byte_size`. Owed; needs port 9008.
