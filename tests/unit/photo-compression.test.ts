import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  EDGE_LADDER,
  PHOTO_TARGET_BYTES,
  QUALITY_LADDER,
  compressionAttempts,
  isCompressibleImage,
  needsPreScale,
  scaleToEdge,
} from '../../apps/erp/src/components/photo-compression';
import { MAX_IMAGE_BYTES, PURPOSE_LIMITS, isImageContentType } from '@shareat/domain';

/**
 * T-296 — Ian, 2026-09-12: *"every uploaded photo accross the app to not exceed 1mb so compress it
 * before uploading."*
 *
 * ⭐ The browser half cannot be unit tested — canvas and `createImageBitmap` need a browser. The
 * DECISIONS can be, and they are the part that fails silently: a ladder that never reaches the
 * target, an upscale that adds bytes, a short side rounded to zero. Those are executed here.
 *
 * The server half — the ceiling that makes the rule a guarantee rather than a tendency — is
 * asserted against the real exported constants, not restated.
 */

const repoRoot = path.resolve(__dirname, '../..');

describe('the two limits agree, and the browser aims UNDER the server', () => {
  it('⭐ the client target is strictly below the server ceiling', () => {
    // ⛔ If these were equal, a marginal encode at 1,048,577 bytes would be refused by the layer
    //    whose message is about bytes rather than about what to do next. The gap is the point.
    expect(PHOTO_TARGET_BYTES).toBeLessThan(MAX_IMAGE_BYTES);
  });

  it('the server ceiling is exactly 1 MB, as Ian stated it', () => {
    expect(MAX_IMAGE_BYTES).toBe(1024 * 1024);
  });

  it('⚠️ every purpose that accepts an image has a per-purpose limit ABOVE the photo ceiling', () => {
    // The photo rule must be the binding one for images. A purpose whose own cap fell below 1 MB
    // would refuse with the wrong message — about that purpose, not about photos.
    for (const [purpose, limits] of Object.entries(PURPOSE_LIMITS)) {
      if (!limits.types.some((t) => isImageContentType(t))) continue;
      expect(limits.maxBytes, `${purpose} caps images below the app-wide photo ceiling`).toBeGreaterThanOrEqual(
        MAX_IMAGE_BYTES,
      );
    }
  });

  it('⛔ PDFs are NOT caught by the image ceiling', () => {
    // They cannot be canvas-re-encoded, and the rule Ian stated is about photos.
    expect(isImageContentType('application/pdf')).toBe(false);
    expect(isCompressibleImage('application/pdf')).toBe(false);
    expect(PURPOSE_LIMITS.onboarding_document.maxBytes).toBeGreaterThan(MAX_IMAGE_BYTES);
  });

  /**
   * ⭐ **The REASON for the PDF exemption, asserted rather than left in prose — DEF-307's lesson
   * is that a justification living only in a comment is a justification the next person deletes.**
   *
   * The exemption exists because a document purpose accepts a file far larger than any photo, and
   * that file cannot be shrunk by re-encoding. If some future change made every purpose's cap fall
   * to the photo ceiling, the exemption would be pointless and this test says so by failing.
   */
  it('⭐ at least one purpose accepts a PDF far larger than the photo ceiling — the exemption has a job', () => {
    const pdfPurposes = Object.entries(PURPOSE_LIMITS).filter(([, l]) =>
      l.types.includes('application/pdf'),
    );
    expect(pdfPurposes.length).toBeGreaterThan(0);

    const largest = Math.max(...pdfPurposes.map(([, l]) => l.maxBytes));
    // ⛔ Not "greater than" by a byte — meaningfully larger, or the exemption buys nothing and the
    //    added complexity of a per-type rule is unjustified.
    expect(largest).toBeGreaterThanOrEqual(MAX_IMAGE_BYTES * 4);
  });

  /**
   * ⛔ **And the framework bound must clear that PDF, which is why T-282/DEF-317's 26 MB must not
   * be "tidied" down to 1 MB now that photos are small.** Doing so would re-create DEF-317 for
   * documents: a silent 413 before the action runs, with no error anywhere.
   */
  it('⛔ next.config.js body limit still clears the largest PDF purpose', () => {
    const config = readFileSync(
      path.join(repoRoot, 'apps/erp/next.config.js'),
      'utf8',
    );
    const declared = /bodySizeLimit:\s*['"](\d+(?:\.\d+)?)(kb|mb)['"]/i.exec(config);
    expect(declared, 'apps/erp declares no bodySizeLimit — DEF-317').not.toBeNull();
    const bytes =
      Number(declared![1]) * (declared![2]!.toLowerCase() === 'mb' ? 1024 * 1024 : 1024);
    const largestPurpose = Math.max(...Object.values(PURPOSE_LIMITS).map((l) => l.maxBytes));
    expect(bytes).toBeGreaterThanOrEqual(largestPurpose);
  });
});

describe('scaleToEdge', () => {
  it('scales a landscape photo by its long edge', () => {
    expect(scaleToEdge(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
  });

  it('scales a PORTRAIT photo by its long edge too — height, not width', () => {
    // A phone photo of a receipt is portrait far more often than not. Constraining width would
    // leave a 3000px-tall image that is still enormous.
    expect(scaleToEdge(3000, 4000, 2000)).toEqual({ width: 1500, height: 2000 });
  });

  it('⛔ never upscales — a small photo is left alone', () => {
    // Enlarging adds bytes and no information, which is the opposite of the point.
    expect(scaleToEdge(900, 600, 2000)).toEqual({ width: 900, height: 600 });
  });

  it('⛔ an extreme aspect ratio never rounds the short side to ZERO', () => {
    // A zero-area canvas draws nothing and encodes to a few bytes that read as brilliant
    // compression. This is the failure that looks most like success.
    const out = scaleToEdge(4000, 3, 1280);
    expect(out.height).toBeGreaterThanOrEqual(1);
    expect(out.width).toBe(1280);
  });
});

describe('the attempt ladder', () => {
  it('⭐ tries DIMENSIONS before crushing QUALITY', () => {
    // This is the answer to packages/core/src/exif.ts:20's objection — detail loss on printed
    // figures comes from quality, not from sensible downscaling. Edge must be the outer loop.
    const attempts = compressionAttempts();
    const firstDrop = attempts.findIndex((a) => a.edge === EDGE_LADDER[1]);
    const worstQualityAtFullEdge = attempts
      .slice(0, firstDrop)
      .every((a) => a.edge === EDGE_LADDER[0]);
    expect(worstQualityAtFullEdge).toBe(true);
    expect(attempts[0]).toEqual({ edge: EDGE_LADDER[0], quality: QUALITY_LADDER[0] });
  });

  it('starts at the highest quality and the largest edge', () => {
    // A photo that already fits at 0.85 must never be re-encoded at 0.75.
    expect(attemptsAreDescending()).toBe(true);
  });

  it('has a floor — it does not degrade indefinitely', () => {
    const edges = [...new Set(compressionAttempts().map((a) => a.edge))];
    expect(Math.min(...edges)).toBe(1280);
  });

  function attemptsAreDescending(): boolean {
    const a = compressionAttempts();
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1]!;
      const cur = a[i]!;
      if (cur.edge === prev.edge && cur.quality > prev.quality) return false;
      if (cur.edge > prev.edge) return false;
    }
    return true;
  }
});

describe('needsPreScale — the canvas ceiling', () => {
  it('flags a 48 MP photo', () => {
    // ⛔ Mobile Safari returns a BLANK canvas past ~16.7 MP instead of throwing.
    expect(needsPreScale(8000, 6000)).toBe(true);
  });

  it('leaves an ordinary 12 MP photo alone', () => {
    expect(needsPreScale(4000, 3000)).toBe(false);
  });
});

describe('⛔ THE PLANT — every file input in the app goes through PhotoInput', () => {
  it('no raw <input type="file"> survives outside PhotoInput itself', () => {
    // The rule Ian stated is "across the app". A new upload screen added with a plain file input
    // would be uncompressed AND would hit the server ceiling with no explanation — silently, and
    // only for whoever happens to upload a large photo. Same shape as every "guard narrower than
    // its claim" defect in this repo, so the population is enumerated rather than assumed.
    const tracked = execFileSync('git', ['ls-files', '-z', 'apps/erp/src'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((f) => f.endsWith('.tsx'));

    const offenders = tracked.filter((f) => {
      if (f.endsWith('components/PhotoInput.tsx')) return false;
      const src = readFileSync(path.join(repoRoot, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => (l.indexOf('//') === -1 ? l : l.slice(0, l.indexOf('//'))))
        .join('\n');
      return /type=["']file["']/.test(src);
    });

    expect(offenders.sort()).toEqual([]);
  });
});
