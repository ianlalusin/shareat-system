/**
 * Deterministic initials badge for a saved QR tile.
 *
 * This is the fallback that makes the icon step optional. Fetching a brand logo
 * needs the network, and the POS runs offline on a tablet — so every saved QR
 * gets initials and a colour computed locally, with zero bytes stored and
 * nothing that can 404 later. A fetched icon is an upgrade on top, never a
 * requirement.
 */

/**
 * Tile colours. Chosen to stay legible with white text in both themes, and
 * spread around the wheel so adjacent tiles rarely collide.
 */
export const INITIALS_PALETTE = [
  "#0F62FE", // blue
  "#0E7C66", // teal
  "#B4530A", // amber
  "#8A2BE2", // violet
  "#B01D4F", // magenta
  "#1F6F3F", // green
  "#0B5F86", // cyan-dark
  "#6B4A1F", // brown
] as const;

/**
 * FNV-1a, so a name always yields the same colour on every device. Math.random
 * would reshuffle the wallet's colours on each render, which reads as a bug.
 */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Up to two letters, taken from the first two words. "GCash Ate Malou" → "GA". */
export function initialsFor(name: string): string {
  const words = (name ?? "")
    .split(/[\s\-–—_/]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);

  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Stable colour for a name. */
export function colorFor(name: string): string {
  return INITIALS_PALETTE[hashString(name ?? "") % INITIALS_PALETTE.length];
}

/** Both halves of the fallback badge in one call. */
export function initialsBadge(name: string): { initials: string; color: string } {
  return { initials: initialsFor(name), color: colorFor(name) };
}
