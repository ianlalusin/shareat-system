/**
 * Badge — T-387 S3 (ADR-013 Amendment 7): a pill, a dot and a word. Never colour alone.
 * No `'use client'`, no hooks (Guard 10). Tokens only (Guards 7-9): warning text is `text-warning-ink`,
 * danger is the soft surface (`bg-danger-surface`), the dot is `bg-current` so it follows the tone's text.
 */
import { statusLabel, statusTone, type Tone } from './status-tone';

export type BadgeProps =
  | { readonly tone: Tone; readonly label: string; readonly status?: undefined; readonly className?: string }
  | { readonly status: string; readonly tone?: undefined; readonly label?: undefined; readonly className?: string };

const TONE_CLASSES: Readonly<Record<Tone, string>> = {
  info: 'bg-info-soft text-info',
  warning: 'bg-warning-soft text-warning-ink',
  success: 'bg-success-soft text-success',
  progress: 'bg-progress-soft text-progress',
  danger: 'bg-danger-surface text-danger',
  closed: 'bg-closed-soft text-closed',
};

export function Badge(props: BadgeProps) {
  const tone: Tone | undefined = props.status !== undefined ? statusTone(props.status) : props.tone;
  const label = props.status !== undefined ? statusLabel(props.status) : props.label;
  if (!tone || !(tone in TONE_CLASSES)) throw new Error('Badge: a tone or a status is required');
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error('Badge: a colour without a word is not allowed; give a non-empty label or a status');
  }
  const { className } = props;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASSES[tone]}${className ? ` ${className}` : ''}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
