import type { Config } from 'tailwindcss';

/**
 * A palette token that still honours Tailwind's `/opacity` modifier.
 *
 * ⛔ Tailwind substitutes `<alpha-value>` with the modifier (`0.5` for `/50`) or with `1` when
 * there is none. A bare `var(--x)` has nowhere to put it, so Tailwind emits **no rule at all** for
 * the modified class — silently. This wrapper is what keeps `bg-warning/20` meaning something.
 */
const alpha = (token: string): string =>
  `color-mix(in srgb, var(${token}) calc(<alpha-value> * 100%), transparent)`;

export default {
  content: ['./src/**/*.{ts,tsx}'],
  // ⭐ T-334 slice 1 — THE SELECTOR STRATEGY IS WHAT KEEPS ~3,485 EXISTING dark: CLASSES ALIVE.
  // There was no darkMode key here at all, so Tailwind sat on its default media strategy and the
  // app followed the OS into dark mode — which nobody chose (ADR-013). Pointing it at the
  // attribute that layout.tsx sets server-side means a dark: class stops firing from the OS and
  // starts firing from the cookie. ⛔ Nothing is deleted in this slice.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      // The ruled palette, surfaced to utilities (bg-brand, text-danger, …). ⛔ The VALUES live in
      // globals.css as CSS custom properties — one source of truth, and the one the browser
      // actually consumes. These are references, never copies.
      //
      // ⛔⛔ THE `color-mix` WRAPPER IS NOT DECORATION — a bare `var(--brand)` SILENTLY DELETES
      // every opacity-modifier utility. Measured during review: with plain `var(…)` values,
      // `bg-brand` emits a rule but `text-brand/50` and `bg-warning/20` emit NOTHING AT ALL — no
      // rule, no warning, no build error. ⚠️ That is a trap laid for slice 4: `src` already holds
      // 11 amber opacity usages (`bg-amber-950/20`, `bg-amber-50/60`, `border-amber-700/60`, …)
      // and ADR-013 routes every one of them to `--warning`. They would lose their background or
      // border the moment they were migrated, with the build still green.
      //
      // ⭐ `color-mix` keeps ONE source of truth (the hex in globals.css) while restoring the
      // modifier; the channel-triple form would work too but needs each colour declared twice.
      // With no modifier Tailwind substitutes `1`, so `calc(1 * 100%)` is the colour untouched.
      colors: {
        brand: { DEFAULT: alpha('--brand'), hover: alpha('--brand-hover'), ink: alpha('--brand-ink') },
        danger: { DEFAULT: alpha('--danger'), surface: alpha('--danger-surface') },
        warning: { DEFAULT: alpha('--warning'), soft: alpha('--warning-soft'), ink: alpha('--warning-ink') },
        success: { DEFAULT: alpha('--success'), soft: alpha('--success-soft') },
        info: { DEFAULT: alpha('--info'), soft: alpha('--info-soft') },
        progress: { DEFAULT: alpha('--progress'), soft: alpha('--progress-soft') },
        closed: { DEFAULT: alpha('--closed'), soft: alpha('--closed-soft') },
        canvas: alpha('--canvas'),
        surface: { DEFAULT: alpha('--surface'), border: alpha('--surface-border') },
        field: { DEFAULT: alpha('--field'), border: alpha('--field-border') },
        ink: alpha('--ink'),
        muted: alpha('--muted'),
      },
      // next/font sets --font-body and --font-display on <html> (layout.tsx).
      fontFamily: {
        sans: ['var(--font-body)', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
