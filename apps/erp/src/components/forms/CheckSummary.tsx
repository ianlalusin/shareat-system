/**
 * CheckSummary - T-440 S1. The ONE persistent live region of a checked form: "Save is off until: ...".
 * Once the checks are active it is ALWAYS in the DOM (empty text when nothing blocks Save), so a screen reader announces every
 * change of its text; a region that appears together with its text is often not announced. Before the checks start (the server
 * render), while a record is locked, or outside a checked form it renders nothing. The per-field helper lines are not live
 * regions, so one keystroke is announced once.
 */
export function CheckSummary({ active, summary }: { active: boolean; summary: string | null }) {
  if (!active) return null;
  return (
    <p role="status" aria-live="polite" className="mt-3 min-h-5 text-sm text-ink/70">
      {summary ?? ''}
    </p>
  );
}
