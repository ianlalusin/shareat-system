'use client';

/**
 * The question asked before an administrator PIN is issued.
 *
 * The PIN itself is the one thing on this page a manager types for somebody else, so the
 * confirmation is not ceremony: issuing a new PIN replaces the old one and ends that person's
 * live sessions. The form (a shared CheckedForm with the PIN rules, built in staff/page.tsx so its server
 * action stays visible to the rule guards) keeps the input on the same row as the button; the
 * explanation lives in the dialog, not in permanent prose above the field.
 */
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Dialog } from '@/components/ui';

export function IssueAdminPinConfirm({
  displayName,
  hasPin,
  children,
}: {
  displayName: string;
  hasPin: boolean;
  /** The CheckedForm; its SubmitButton marks itself aria-busy while the action runs. */
  children: ReactNode;
}) {
  const shell = useRef<HTMLDivElement>(null);
  // True only inside confirm()'s own requestSubmit() call. It cannot outlive that call, so a submit that never
  // fires (a refusal, an invalid field) leaves nothing behind that could wave the NEXT issue past the question.
  const approved = useRef(false);
  const [open, setOpen] = useState(false);
  // React's form status shows on the SubmitButton (aria-busy) and ends when the action settles.
  const inFlight = () => shell.current?.querySelector('[aria-busy="true"]') != null;

  // Runs after CheckedForm's own handler: a failing PIN rule has already stopped the submit, so only a valid one asks.
  function onSubmit(event: FormEvent<HTMLDivElement>) {
    if (event.defaultPrevented || approved.current) return;
    event.preventDefault();
    if (!inFlight()) setOpen(true);
  }

  function confirm() {
    setOpen(false);
    if (inFlight()) return;
    approved.current = true;
    try {
      shell.current?.querySelector('form')?.requestSubmit();
    } finally {
      approved.current = false;
    }
  }

  return (
    <>
      <div ref={shell} onSubmit={onSubmit} className="contents">
        {children}
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={hasPin ? 'Re-issue this administrator PIN?' : 'Issue this administrator PIN?'}
        description={`This replaces ${displayName}'s approval code.`}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" icon={null} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" icon={null} onClick={confirm}>
              Yes, {hasPin ? 're-issue' : 'issue'} PIN
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <p>
            An administrator PIN is {displayName}&rsquo;s personal approval code. They type it to
            approve a void, a reversal, a delete or a cutover step.
          </p>
          <p>
            A new PIN takes effect immediately. The old PIN stops working and any live sessions for
            this person end on every device.
          </p>
          <p className="text-muted">
            Give the PIN to {displayName} directly — never in a group chat or a shared note.
          </p>
        </div>
      </Dialog>
    </>
  );
}
