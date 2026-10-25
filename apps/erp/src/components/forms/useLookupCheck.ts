'use client';
/**
 * useLookupCheck - T-475 S1. Facts a page cannot hold (is this invoice number already recorded?) come from a server lookup.
 *
 * Debounced 400 ms after the last change of `inputs`, so typing is one question, not one per key. The answer is returned only
 * while it belongs to the CURRENT inputs: while it is pending, after the inputs moved on, or when the lookup failed, the result
 * is null, and a check given null facts gives NO verdict. A pending or failed lookup never blocks a save and never warns; the
 * server judges the real save either way.
 */
import { useEffect, useState } from 'react';

const LOOKUP_DEBOUNCE_MS = 400;

export function useLookupCheck<I extends object, A>(action: (input: I) => Promise<A>, inputs: I | null): A | null {
  const key = inputs === null ? null : JSON.stringify(inputs);
  const [answered, setAnswered] = useState<{ key: string; answer: A } | null>(null);

  useEffect(() => {
    if (key === null) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      action(JSON.parse(key) as I)
        .then((answer) => {
          if (live) setAnswered({ key, answer });
        })
        .catch(() => {
          // A failed lookup is "no verdict": nothing to show, nothing blocked.
        });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, action]);

  return answered !== null && answered.key === key ? answered.answer : null;
}
