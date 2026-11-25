'use client';
/**
 * Ask ERP - the floating button and its side panel. T-641 (docs/tasks/641-ask-erp.md).
 *
 * Mounted once by `AppShell`, only for a person who holds `use_ask_erp`; `AppShell` already leaves it out of /pos, /clock and sign-in (it returns bare children there).
 * Presentation only: the server action authorizes again, asserts the same field rule and reads every figure through its own capability. The conversation lives in this component only.
 *
 * What the person sees: a question box ruled by `ASK_ERP_RULES` (1 to 500 characters; the house live check and the count), the last ten turns kept, an answer with the screens its
 * figures came from as links (built by the server from the tools that ran, never written by the model), and, plainly, that an answer is to be checked on its screen.
 *
 * The form is a house `CheckedForm` so the rule is checked live and Ask is truly disabled while it fails. A valid submit is taken over here (`onSubmitCapture` stops React's own
 * form action, because the reply is shown in the panel and a form action's return value is not); the same server action is the form's `action` for a browser without scripts.
 */
import Link from 'next/link';
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import { ASK_ERP_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Banner, Button, Field, Textarea } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { NAV_LINK } from '@/components/action-link';
import { askErpAction, askErpFormAction, type AskReply } from '../../app/ask-erp/actions';

/** The turns sent back with a question (the server keeps the last ten too; a test pins both to the domain's number). */
const KEEP_TURNS = 10;
const QUESTION_ID = 'ask-erp-question';

interface Source {
  label: string;
  href: string;
}
interface Turn {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
}

const EXAMPLES = ['What is our cost driver this month?', 'Anything unusual this week?', 'How do I record an expense?'];

export function AskErpLauncher() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) document.getElementById(QUESTION_ID)?.focus();
  }, [open]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [turns, pending]);

  function ask(form: HTMLFormElement) {
    const box = form.elements.namedItem('question');
    const q = box instanceof HTMLTextAreaElement ? box.value.trim() : '';
    if (q === '' || pending) return;
    const history = turns.slice(-KEEP_TURNS).map(({ role, content }) => ({ role, content }));
    const data = new FormData();
    data.set('question', q);
    data.set('history', JSON.stringify(history));
    setTurns((t) => [...t, { role: 'user', content: q }]);
    setError(null);
    form.reset();
    setCount(0);
    startTransition(async () => {
      let reply: AskReply;
      try {
        reply = await askErpAction(data);
      } catch {
        reply = { ok: false, error: 'The question could not be sent. Check the connection and try again.' };
      }
      if (reply.ok) {
        setTurns((t) => [...t, { role: 'assistant', content: reply.answer, sources: reply.sources }]);
        setWarning(reply.warning);
      } else setError(reply.error);
    });
  }

  function fill(example: string) {
    const box = document.getElementById(QUESTION_ID);
    if (!(box instanceof HTMLTextAreaElement)) return;
    box.value = example;
    // the form's own live check listens for `input`
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
    setCount(example.length);
  }

  if (!open) {
    return (
      <div className="fixed bottom-4 right-4 z-40 print:hidden">
        <Button variant="primary" icon={null} onClick={() => setOpen(true)}>
          Ask ERP
        </Button>
      </div>
    );
  }

  return (
    <aside
      aria-label="Ask ERP"
      className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-surface-border bg-surface shadow-xl sm:max-w-md print:hidden"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-surface-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">Ask ERP</h2>
          <p className="mt-0.5 text-xs text-muted">Answers come from the company&apos;s documents and the screens you may open. Check an important figure on its screen.</p>
        </div>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      <div ref={log} role="log" aria-live="polite" aria-busy={pending} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {turns.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-ink">Ask how something works, or about a store&apos;s figures for a period.</p>
            <ul className="space-y-2">
              {EXAMPLES.map((ex) => (
                <li key={ex}>
                  <Button variant="secondary" icon={null} className="text-left" onClick={() => fill(ex)}>
                    {ex}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {turns.map((t, i) =>
          t.role === 'user' ? (
            <p key={i} className="ml-8 whitespace-pre-wrap rounded-[12px] bg-canvas px-3 py-2 text-sm text-ink">
              {t.content}
            </p>
          ) : (
            <div key={i} className="space-y-1">
              <p className="whitespace-pre-wrap text-sm text-ink">{t.content}</p>
              {t.sources && t.sources.length > 0 ? (
                <ul className="flex flex-wrap gap-x-4">
                  {t.sources.map((s) => (
                    <li key={s.href}>
                      <Link href={s.href} className={NAV_LINK}>
                        {s.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ),
        )}
        {pending ? <p className="text-sm text-muted">Looking that up...</p> : null}
        {error ? <Banner tone="error">{error}</Banner> : null}
        {warning ? <Banner tone="warning">{warning}</Banner> : null}
      </div>

      <CheckedForm
        rules={ASK_ERP_RULES}
        action={askErpFormAction}
        className="shrink-0 space-y-2 border-t border-surface-border px-4 py-3"
        onSubmitCapture={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          ask(e.currentTarget);
        }}
      >
        <div onInput={(e) => setCount((e.target as HTMLTextAreaElement).value.length)}>
          <Field label="Your question" rule={ASK_ERP_RULES.question}>
            <Textarea
              {...nativeAttrs(ASK_ERP_RULES.question)}
              id={QUESTION_ID}
              rows={3}
              className="w-full"
              placeholder="Type your question"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs tabular-nums text-muted">
            {count}/{ASK_ERP_RULES.question.max}
          </span>
          <Button variant="primary" type="submit" icon={null} disabled={pending}>
            Ask
          </Button>
        </div>
      </CheckedForm>
    </aside>
  );
}
