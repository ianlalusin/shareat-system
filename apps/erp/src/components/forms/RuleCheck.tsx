'use client';
/**
 * RuleCheck - T-475 S1. One BUSINESS-rule line inside a CheckedForm / EditableRecord (docs/tasks/475-ap-expense-live-checks-
 * self-verify-linkage.md section 3.2). It resolves its check BY ID from the shared leaf, so the page names a rule and passes
 * plain-JSON facts; the sentence lives only in the leaf, and the server throws the very same one.
 *
 * - It asks the form to also read the controls the check lists in `watch` (the controls stay uncontrolled).
 * - On every change it runs the check and reports the verdict to the form: a BLOCK turns Save off (and is listed in "Save is off
 *   until: ..."), a WARN never does.
 * - It prints its own polite live line: danger text + icon for a block, warning text + icon for a warn, never colour alone.
 * - Before the checks start (the server render), while a record is locked, or outside a form it renders nothing, and a check
 *   that cannot be evaluated (missing or stale facts) gives NO verdict: the server re-checks every save anyway.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo } from 'react';
import { BUSINESS_CHECKS } from '@shareat/domain/business-rules';
import { CheckContext } from './context';

/**
 * Facts a client lookup supplies to the RuleChecks beneath it (the invoice-number lookup): a RuleCheck given no `facts` prop
 * reads them from here, so the page can still name the rule (`<RuleCheck id=... />`) while a client wrapper holds the answer.
 */
export const RuleFactsContext = createContext<unknown>(undefined);

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const ICON = {
  viewBox: '0 0 24 24',
  width: 14,
  height: 14,
  className: 'mt-px h-3.5 w-3.5 shrink-0',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false',
} as const;

export function RuleCheck({ id, facts: given }: { id: string; facts?: unknown }) {
  const ctx = useContext(CheckContext);
  const lookedUp = useContext(RuleFactsContext);
  const facts = given !== undefined ? given : lookedUp;
  const check = BUSINESS_CHECKS[id];
  const track = ctx?.track;
  const setVerdict = ctx?.setVerdict;
  const active = ctx?.active === true;
  const values = ctx?.values;

  // Ask the form to read the controls this check reads. Released on unmount.
  useIsomorphicLayoutEffect(() => (check && track ? track(check.watch) : undefined), [check, track]);

  const verdict = useMemo(() => {
    if (!check || !active || !values) return null;
    try {
      return check.run(facts, values);
    } catch {
      return null; // a broken fact never blocks a save; the server judges it
    }
  }, [check, active, values, facts]);

  const level = verdict?.level;
  const sentence = verdict?.sentence;
  useEffect(() => {
    if (!setVerdict || !level || sentence === undefined) return undefined;
    setVerdict(id, { level, sentence });
    return () => setVerdict(id, null);
  }, [id, setVerdict, level, sentence]);

  if (!active || !check) return null;
  const isBlock = level === 'block';
  return (
    <p
      aria-live="polite"
      data-rule-check={id}
      className={verdict ? `mt-1 flex items-start gap-1.5 text-xs ${isBlock ? 'text-danger' : 'text-warning-ink'}` : undefined}
    >
      {verdict ? (
        <>
          <svg {...ICON}>
            {isBlock ? (
              <>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7.5v5.5M12 16.5v.01" />
              </>
            ) : (
              <>
                <path d="M12 3.5l9.5 16.5h-19z" />
                <path d="M12 10v4.5M12 17.5v.01" />
              </>
            )}
          </svg>
          <span>
            <span className="sr-only">{isBlock ? 'Problem: ' : 'Warning: '}</span>
            {sentence}
          </span>
        </>
      ) : null}
    </p>
  );
}
