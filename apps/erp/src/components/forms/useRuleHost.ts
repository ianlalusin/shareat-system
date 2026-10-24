/**
 * T-475 - the form-side half of business-rule checks: the registry of extra control names a `<RuleCheck>` asked the form to
 * read (its check's `watch`), and the two callbacks the check context hands out. Shared by CheckedForm and EditableRecord.
 *
 * The controls stay UNCONTROLLED: a watched name is only READ, by the same delegated input/change listener and the same
 * `reset` re-read as a ruled field. Watching is reference-counted, so two checks naming one control share it.
 */
import { useCallback, useMemo, useRef, type Dispatch, type RefObject } from 'react';
import type { CheckCtx, CheckedFormEvent } from './check-state';
import { readNamedValues } from './check-dom';

export interface RuleHost {
  setVerdict: CheckCtx['setVerdict'];
  track: CheckCtx['track'];
  /** The names currently watched (read at event time, so a late `track` is picked up by the next input). */
  watchedNames(): string[];
}

export function useRuleHost(formRef: RefObject<HTMLFormElement | null>, dispatch: Dispatch<CheckedFormEvent>): RuleHost {
  const watched = useRef(new Map<string, number>());
  const setVerdict = useCallback<CheckCtx['setVerdict']>((id, verdict) => dispatch({ type: 'verdict', id, verdict }), [dispatch]);
  const track = useCallback<CheckCtx['track']>(
    (names) => {
      const fresh: string[] = [];
      for (const n of names) {
        const held = watched.current.get(n) ?? 0;
        if (held === 0) fresh.push(n);
        watched.current.set(n, held + 1);
      }
      const form = formRef.current;
      if (form && fresh.length > 0) dispatch({ type: 'watch', values: readNamedValues(form, fresh) });
      return () => {
        for (const n of names) {
          const held = (watched.current.get(n) ?? 1) - 1;
          if (held <= 0) watched.current.delete(n);
          else watched.current.set(n, held);
        }
      };
    },
    [formRef, dispatch],
  );
  const watchedNames = useCallback(() => [...watched.current.keys()], []);
  return useMemo(() => ({ setVerdict, track, watchedNames }), [setVerdict, track, watchedNames]);
}
