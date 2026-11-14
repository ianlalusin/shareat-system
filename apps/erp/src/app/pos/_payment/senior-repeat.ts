/**
 * T-575 (bible row 462) - the payment screen's side of the repeat senior/PWD card warning: ask the server when the ID box loses focus, say the answer in plain words under the box.
 * It never blocks Finish. Offline there is no question at all (the tablet cannot see another tablet's bills), and any failure is silent.
 */
import { formatBusinessDateTime } from '@shareat/core/datetime';

/** The server's answer (POST /api/pos/senior-id-check): how many earlier uses, and the most recent one. Never a name. */
export interface SeniorIdCheck {
  used: number;
  lastReceiptNo: string | null;
  lastAt: string | null;
}

const manilaDay = (d: Date): string => formatBusinessDateTime(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
const manilaTime = (d: Date): string => formatBusinessDateTime(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The sentence under the ID box, or null when the card was not used before. "today" when the last use was today (Manila), else the day. */
export function repeatWarning(check: SeniorIdCheck, nowMs: number): string | null {
  if (check.used <= 0) return null;
  const at = check.lastAt ? new Date(check.lastAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at : null;
  const day = when ? (manilaDay(when) === manilaDay(new Date(nowMs)) ? 'today' : `on ${formatBusinessDateTime(when, { dateStyle: 'medium' })}`) : null;
  const detail = [check.lastReceiptNo ? `receipt ${check.lastReceiptNo}` : null, when ? manilaTime(when) : null].filter((x) => x !== null).join(', ');
  return `This ID was already used${day ? ` ${day}` : ''} at this store${detail ? ` (${detail})` : ''}. You can still continue.`;
}

const isCheck = (v: unknown): v is SeniorIdCheck => {
  const c = v as Partial<SeniorIdCheck> | null;
  return !!c && typeof c.used === 'number' && (c.lastReceiptNo === null || typeof c.lastReceiptNo === 'string') && (c.lastAt === null || typeof c.lastAt === 'string');
};

/** Asks the server. Null when there is no answer to show: offline, a blank box, a refusal, a failed request or a reply that is not the contract. Never throws. */
export async function lookupSeniorRepeat(o: { idNumber: string; online: boolean; fetch: typeof fetch }): Promise<SeniorIdCheck | null> {
  const idNumber = o.idNumber.trim();
  if (!o.online || idNumber === '') return null;
  try {
    const res = await o.fetch('/api/pos/senior-id-check', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idNumber }) });
    if (!res.ok) return null;
    const j = (await res.json()) as unknown;
    return isCheck(j) ? { used: j.used, lastReceiptNo: j.lastReceiptNo, lastAt: j.lastAt } : null;
  } catch {
    return null;
  }
}
