/**
 * StatusHero - T-387 S6 (docs/design/t387/OrderStatus.dc.html, option 3): the big state of one record.
 * The StatusIcon, the state word in large type, a chevron progress row, one line on what happens next, and the
 * action slot (the page's existing primary form for that stage, passed as children).
 * Tone `danger` is a side exit (rejected / cancelled / void): the cell at `step` and every later one are greyed
 * (`exited`), the word is red, and no cell is `current`.
 * Server-safe: no client directive, no hooks (Guard 10). Tokens only (Guards 7-9). The icon motion is CSS in app/globals.css.
 */
import { Children, type ReactNode } from 'react';
import { StatusIcon, type StatusIconKind } from './StatusIcon';
import type { Tone } from './status-tone';

export type StatusHeroProps = {
  readonly kind: StatusIconKind;
  readonly word: string;
  readonly step: number;
  readonly steps: readonly string[];
  readonly line: string;
  readonly tone: Tone;
  readonly children?: ReactNode;
};

const TONE_TEXT: Readonly<Record<Tone, string>> = {
  info: 'text-info',
  warning: 'text-warning-ink',
  success: 'text-success',
  progress: 'text-progress',
  danger: 'text-danger',
  closed: 'text-closed',
};

const TONE_SOFT: Readonly<Record<Tone, string>> = {
  info: 'bg-info-soft',
  warning: 'bg-warning-soft',
  success: 'bg-success-soft',
  progress: 'bg-progress-soft',
  danger: 'bg-danger-surface',
  closed: 'bg-closed-soft',
};

type CellState = 'done' | 'current' | 'todo' | 'exited';

const CELL_CLASS: Readonly<Record<CellState, string>> = {
  done: 'bg-success-soft text-success',
  current: 'bg-progress-soft font-semibold text-progress',
  todo: 'bg-canvas text-muted',
  exited: 'bg-canvas text-muted line-through opacity-60',
};

function label(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function StatusHero({ kind, word, step, steps, line, tone, children }: StatusHeroProps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('StatusHero: steps must not be empty');
  if (!Number.isInteger(step) || step < 0 || step > steps.length - 1) {
    throw new Error(`StatusHero: step ${String(step)} is outside 0..${steps.length - 1}`);
  }
  if (typeof word !== 'string' || word.trim() === '') throw new Error('StatusHero: a state needs a word');
  if (typeof line !== 'string' || line.trim() === '') throw new Error('StatusHero: a state needs a next line');
  if (!(tone in TONE_TEXT)) throw new Error(`StatusHero: unknown tone ${JSON.stringify(tone)}`);

  const exit = tone === 'danger';
  const stateOf = (i: number): CellState => (i < step ? 'done' : exit ? 'exited' : i === step ? 'current' : 'todo');
  const hasAction = Children.toArray(children).length > 0;

  return (
    <section
      data-status-hero
      data-tone={tone}
      className="status-hero rounded-xl border border-surface-border bg-surface p-5"
    >
      <div className="flex flex-wrap items-center gap-4">
        <span className={`inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-full ${TONE_SOFT[tone]} ${TONE_TEXT[tone]}`}>
          <StatusIcon kind={kind} />
        </span>
        <div className="min-w-0 grow">
          <p data-status-word className={`text-3xl font-semibold tracking-tight ${TONE_TEXT[tone]}`}>
            {word}
          </p>
          <p data-status-line className="mt-1 text-sm text-muted">
            {line}
          </p>
        </div>
        {hasAction && (
          <div data-status-action className="flex flex-wrap items-end gap-3">
            {children}
          </div>
        )}
      </div>
      <ol className="mt-5 flex gap-1 overflow-x-auto text-xs" aria-label="Progress">
        {steps.map((s, i) => {
          const state = stateOf(i);
          return (
            <li
              key={s}
              data-step-cell
              data-step-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`min-w-[5.5rem] flex-1 px-3 py-2 text-center ${CELL_CLASS[state]}`}
              style={{ clipPath: 'polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%, 10px 50%)' }}
            >
              {label(s)}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
