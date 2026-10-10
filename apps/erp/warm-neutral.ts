/**
 * T-387 S1 addendum: Tailwind's `neutral` ramp, re-valued warm for SharEat Warm / Grill Night.
 *
 * 4,946 `neutral-*` utilities across 154 files read as cold grey on the cream canvas, and stock
 * `text-neutral-500` (the caption colour, 575 lines) is 4.34:1 on `--canvas`, under AA. Re-valuing
 * the palette fixes every file at once; S8 still moves the screens onto the kit.
 *
 * ⛔ Static hexes on purpose: a step is used as BOTH a light-mode and a `dark:` value (bg-neutral-900
 * is the light primary button AND dark:bg-neutral-900 the dark surface), so a theme-switching
 * `var()` would invert one of them. `t387-s1-warm-neutral.test.ts` keeps them honest:
 *   - ANCHORED steps equal the ruled token in globals.css (read from the CSS, so they cannot drift).
 *   - The other steps are stock neutral's OKLCH lightness in `--ink`'s warm hue (h 72°, C 0.013),
 *     so their contrast against anything is within 3% of what it was.
 */
export const WARM_NEUTRAL = {
  50: '#fff9f1',
  100: '#fbf4ec',
  200: '#eadfc6', // = light --surface-border (border-neutral-200, 422 lines)
  300: '#dad3cb',
  400: '#a89f92', // = dark --muted (dark:text-neutral-400, 721 lines): 6.64:1 on the dark surface
  500: '#6b5f4f', // = light --muted (text-neutral-500, 575 lines): 5.68:1 on the cream canvas
  600: '#57514a',
  700: '#453f39',
  800: '#34302b', // = dark --surface-border (dark:border-neutral-800, 421 lines)
  900: '#1c1a18', // = dark --surface (dark:bg-neutral-900, 188 lines)
  950: '#121110', // = dark --canvas (dark:bg-neutral-950, 154 lines)
} as const;
