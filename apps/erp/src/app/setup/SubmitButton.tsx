'use client';

/**
 * `/setup`'s submit button — **disabled the moment the form is submitted.** T-232 slice 2.
 *
 * ## ⛔ Why this needs a guard more than an ordinary form does
 *
 * First run takes a second or two: an organisation, 102 accounts, 38 categories, a person, a role,
 * four grants, a store, a room, a scope row and two credentials, in one transaction. That is
 * exactly long enough for an impatient second click. The advisory lock and the zero-organization
 * refusal make the second submit **harmless** — it can never create a second organisation — but
 * harmless is not the same as good: it lands as *"this system already has an organization, so
 * first-run setup is closed"* on a screen the person is still filling in, which reads like the
 * setup failed when it in fact succeeded.
 *
 * ⚠️ **Not `useFormStatus`.** It is not available here — this app is on `react-dom` **18.3.1**,
 * where that hook does not exist (verified, not assumed: `typeof useFormStatus === 'undefined'`).
 * It arrives with React 19.
 *
 * ⭐ **So the disable hangs off the form's own `submit` event, not the click.** Disabling a submit
 * button inside its own `onClick` can cancel the submission it was meant to accompany; listening
 * for `submit` runs after the browser has accepted it, so the guard can never eat the first
 * attempt — only the second.
 */
import { useEffect, useRef, useState } from 'react';

export function SubmitButton({ children, pendingLabel }: { children: string; pendingLabel: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = () => setBusy(true);
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, []);

  return (
    <button
      ref={ref}
      type="submit"
      disabled={busy}
      // ⚠️ `aria-busy` as well as `disabled`: a screen reader should hear that something is
      // happening, not merely that the control went away.
      aria-busy={busy}
      className="w-full rounded bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
    >
      {busy ? pendingLabel : children}
    </button>
  );
}
