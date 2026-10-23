/**
 * Action icons — T-448 (Ian, 2026-10-22: "instead of text use white icon on red or black button. on hover
 * display button name"). Original line art, the same idiom as `shell/icons.tsx`: 24x24, stroke 1.75,
 * round caps. No hooks, no client directive: `Button` (a server-safe component) draws these.
 *
 * `actionIconFor` maps a button's own words to an icon, so every existing `<Button>Save</Button>` turns
 * into an icon button without each caller changing. Words it does not know keep their text.
 */
import type { ReactNode } from 'react';

export type ActionIconName =
  | 'plus' | 'check' | 'edit' | 'close' | 'trash' | 'eye' | 'filter' | 'download' | 'upload'
  | 'search' | 'send' | 'star' | 'refresh' | 'print' | 'back' | 'next' | 'copy' | 'calculator';

const PATHS: Record<ActionIconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  edit: (
    <>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  filter: <path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5Z" />,
  download: <path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 20h14" />,
  upload: <path d="M12 20V9m-4.5 4.5L12 9l4.5 4.5M5 4h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  send: <path d="M4 12 20 4l-5 16-3.5-6.5L4 12Zm7.5 1.5L20 4" />,
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5Z" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.3-4.6L4 8m0-4v4h4M4 13a8 8 0 0 0 14.3 4.6L20 16m0 4v-4h-4" />,
  print: (
    <>
      <path d="M7 9V3h10v6M7 17H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-3" />
      <path d="M7 14h10v7H7z" />
    </>
  ),
  back: <path d="M19 12H5m6-6-6 6 6 6" />,
  next: <path d="M5 12h14m-6-6 6 6-6 6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  calculator: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8.5 7h7M8.5 11h.01M12 11h.01M15.5 11h.01M8.5 14.5h.01M12 14.5h.01M15.5 14.5h.01M8.5 18h.01M12 18h3.5" />
    </>
  ),
};

export function ActionIcon({ name, size = 16 }: { readonly name: ActionIconName; readonly size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** First match wins. Each pattern reads the START of the button's words ("Save draft", "+ Add supplier"). */
const RULES: ReadonlyArray<readonly [RegExp, ActionIconName]> = [
  [/^\+/, 'plus'],
  [/^(add|new|record|log|create|hire|open a|open new)\b/i, 'plus'],
  [/^(save|update|keep)\b/i, 'check'],
  [/^(edit|change|rename|correct|set)\b/i, 'edit'],
  [/^(cancel|close|dismiss|discard)\b/i, 'close'],
  [/^(delete|remove)\b/i, 'trash'],
  [/^(show|view|preview|open)\b/i, 'eye'],
  [/^(apply|filter)\b/i, 'filter'],
  [/^(download|export)\b/i, 'download'],
  [/^(upload|attach|import)\b/i, 'upload'],
  [/^(search|find|look up)\b/i, 'search'],
  [/^(approve|post|submit|confirm|send|verify)\b/i, 'send'],
  [/^make default\b/i, 'star'],
  [/^(refresh|reload|recompute|rerun|re-run|retry)\b/i, 'refresh'],
  [/^print\b/i, 'print'],
  [/^(back|previous|←)/i, 'back'],
  [/^(next|continue|→)/i, 'next'],
  [/^(copy|duplicate)\b/i, 'copy'],
  [/^(compute|calculate|run)\b/i, 'calculator'],
];

/** The button's words with a leading "+ " dropped: what the hover tip and the accessible name say. */
export function actionName(text: string): string {
  return text.replace(/^\+\s*/, '').trim();
}

export function actionIconFor(text: string): ActionIconName | null {
  const t = text.trim();
  for (const [re, name] of RULES) if (re.test(t)) return name;
  return null;
}
