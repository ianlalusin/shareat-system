import { formatMoney, money } from '@shareat/core/money';
import { Badge } from '@/components/ui';
import type { Tone } from '@/components/ui';

/** Display helpers shared by the three dual-run screens (T-392 S5). Presentation only: no figure is derived here. */

const VERDICT_TONE: Record<string, { tone: Tone; label: string }> = {
  ties: { tone: 'success', label: 'Ties' },
  explained: { tone: 'info', label: 'Explained' },
  open: { tone: 'danger', label: 'Open' },
  no_data: { tone: 'closed', label: 'No data' },
};

export function VerdictBadge({ verdict }: { verdict: string }) {
  const v = VERDICT_TONE[verdict] ?? { tone: 'warning' as Tone, label: verdict };
  return <Badge tone={v.tone} label={v.label} />;
}

export const FAMILY_LABEL: Record<string, string> = {
  tie: 'Ties',
  policy: 'Policy',
  timing: 'Timing',
  encoder: 'Encoder',
  defect: 'Defect',
  scope: 'Scope',
  open: 'Open',
};

export function peso(amount: string): string {
  return formatMoney(money(amount));
}

/** True for a real calendar date that is a Monday. */
export function isMonday(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(y, mo - 1, da));
  return d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da && d.getUTCDay() === 1;
}

export function manilaDateTime(d: Date): string {
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
