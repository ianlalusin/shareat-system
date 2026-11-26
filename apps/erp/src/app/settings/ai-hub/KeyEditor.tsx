'use client';
/**
 * T-642: one provider's key box. A saved key shows only "•••• " and the last 4 characters the server already returns, with a quiet Edit button;
 * the password box, Cancel and Save appear only after Edit. A provider with no key shows the box straight away.
 *
 * ⛔ The key is never read here: the box is uncontrolled and never pre-filled, and nothing keeps its value (no state, no storage, no URL) beyond the form submit.
 * `quietSummary`: an untouched empty box does not print "To save, fix the field marked above" (Save is still off until a whole key is pasted).
 */
import { useState } from 'react';
import { AI_KEY_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { Button, Field, Input } from '@/components/ui';
import { saveKeyAction } from './actions';

export function KeyEditor({ provider, providerLabel, hasKey, last4 }: { provider: string; providerLabel: string; hasKey: boolean; last4: string | null }) {
  const [editing, setEditing] = useState(!hasKey);
  if (hasKey && !editing) {
    return (
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">
          Key <code className="ml-1 font-mono text-base tracking-wider text-ink">•••• {last4}</code>
        </p>
        <Button variant="secondary" aria-label={`Edit the ${providerLabel} key`} onClick={() => setEditing(true)}>
          Edit
        </Button>
      </div>
    );
  }
  return (
    <CheckedForm rules={AI_KEY_RULES} action={saveKeyAction} quietSummary className="space-y-3" autoComplete="off">
      <input type="hidden" name="provider" value={provider} />
      <Field label={hasKey ? 'New key' : 'Paste the key'} rule={AI_KEY_RULES.key}>
        <Input {...nativeAttrs(AI_KEY_RULES.key)} type="password" autoComplete="off" spellCheck={false} autoFocus={hasKey} className="w-full" />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        {hasKey && (
          <Button variant="secondary" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
        <SubmitButton variant="primary" pendingLabel="Saving…">
          Save
        </SubmitButton>
      </div>
    </CheckedForm>
  );
}
