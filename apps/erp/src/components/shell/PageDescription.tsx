'use client';

/**
 * T-348 S1 (DEF-474) — the shared page-title description: full width, clamped at 3 lines with the
 * browser's own "…", and a chevron control that reveals the rest when it overflows. One component,
 * every title description (bible §1.2c). `docs/tasks/348-def-440-two-column-page-width.md` §S1.
 *
 * Ian's S0 pick (Amendment A1, T1): an inline chevron pinned to the end of line 3 over a short
 * fade, native "…" visible, zero layout shift.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Whether the paragraph's full content height exceeds its clamped height by more than a 1px
 * rounding tolerance. `scrollHeight` is the full content height whether the paragraph is clamped
 * or expanded, so one formula is right in both states — a `scrollHeight > clientHeight` check goes
 * false the moment the user expands, and the collapse control would vanish under their own click.
 */
export function exceedsLines(scrollHeight: number, lineHeightPx: number, lines = 3): boolean {
  return scrollHeight > Math.ceil(lineHeightPx * lines) + 1;
}

// React warns ("useLayoutEffect does nothing on the server") the moment a component using it is
// part of an initial server render — which every one of the 102 call sites is. `useEffect` is a
// no-op-shaped stand-in server-side (SSR never runs either), so swapping only there keeps the
// client's synchronous, pre-paint measurement (no flash of the wrong control state) while keeping
// the console clean on the server pass — the spec's own "no hydration warning" smoketest leg.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface PageDescriptionProps {
  readonly children: ReactNode;
  /** Spacing only (e.g. `mt-1`, where the site already had it) — size and tone belong here. */
  readonly className?: string;
}

interface DescriptionState {
  readonly overflows: boolean;
  readonly expanded: boolean;
}

const INITIAL_STATE: DescriptionState = { overflows: false, expanded: false };

export function PageDescription({ children, className }: PageDescriptionProps) {
  const id = useId();
  const pRef = useRef<HTMLParagraphElement>(null);
  const [state, setState] = useState<DescriptionState>(INITIAL_STATE);
  const { overflows, expanded } = state;

  // Measured on mount and on every resize — the same formula, `exceedsLines`, in both cases, so a
  // window narrowed after mount reinstates the control exactly as a first render past the ceiling
  // would have shown it.
  useIsomorphicLayoutEffect(() => {
    const p = pRef.current;
    if (!p) return;

    const measure = () => {
      const lineHeightPx = parseFloat(getComputedStyle(p).lineHeight);
      setState((prev) => ({ ...prev, overflows: exceedsLines(p.scrollHeight, lineHeightPx) }));
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(p);
    return () => observer.disconnect();
  }, []);

  // Item 6 — a link hidden by the clamp must not take focus invisibly. React focus events bubble,
  // so this fires for any focusable descendant, but the signal is `p.scrollTop`, not a rect
  // comparison (D2 root cause, proved in an isolated browser probe, not guessed): `line-clamp-3`'s
  // `overflow: hidden` still makes the <p> a scroll container even with no visible scrollbar, and
  // Chrome/WebKit/Firefox all scroll a just-focused descendant into view as part of the focusing
  // steps — INCLUDING one hidden only by the clamp — before any event handler runs. By the time
  // this fires, the <p> has already scrolled itself to reveal the link, so `getBoundingClientRect()`
  // on the link and the <p> come back aligned and a bottom/bottom comparison is always false.
  // `scrollTop` is the signal that survives: it is exactly the distance the browser just moved to
  // reveal a link the clamp was hiding, and stays 0 for a link that was already visible (nothing
  // needed scrolling).
  const handleFocus = () => {
    if (expanded) return;
    const p = pRef.current;
    if (!p) return;
    if (p.scrollTop > 0) {
      setState((prev) => ({ ...prev, expanded: true }));
    }
  };

  const toggle = () => setState((prev) => ({ ...prev, expanded: !prev.expanded }));

  return (
    <div className="relative">
      <p
        ref={pRef}
        id={id}
        onFocus={handleFocus}
        className={`text-sm text-neutral-600 dark:text-neutral-400 ${expanded ? '' : 'line-clamp-3'} ${className ?? ''}`}
      >
        {children}
      </p>
      {overflows && (
        // F1 — the 44×44 HIT area (min-h-11 min-w-11) must stay for touch-target-geometry.ts, but
        // painting it solid covers the end of line 2 as well as line 3. The button itself is
        // transparent; only a 20px-tall inner strip (h-5 = 1.25rem, the text-sm line height),
        // bottom-aligned by the button's own `items-end`, carries the fade and the chevron's
        // backing — so the extra hit-area padding above it never hides line 2's text.
        // F2 — the app paints no page background (body computes transparent; the canvas is the
        // UA's own for `color-scheme`), so `bg-[Canvas]`/`from-transparent to-[Canvas]` — the CSS
        // system colour — is correct in both themes with no `dark:` variant needed, unlike
        // `bg-white`/`dark:bg-neutral-950`, which assumed a page background this app never sets.
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={expanded ? 'Show less' : 'Show full description'}
          onClick={toggle}
          className="absolute bottom-0 right-0 flex min-h-11 min-w-11 items-end justify-end bg-transparent text-neutral-600 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          <span className="flex h-5 items-center">
            <span aria-hidden="true" className="h-5 w-6 bg-gradient-to-r from-transparent to-[Canvas]" />
            <span className="flex h-5 w-5 items-center justify-center bg-[Canvas]">
              <ChevronIcon expanded={expanded} />
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

/** No `transition-*` class — item 4 wants the rotation instant, not animated. */
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 ${expanded ? 'rotate-180' : ''}`}
    >
      <path d="M5 7l5 5 5-5" />
    </svg>
  );
}
