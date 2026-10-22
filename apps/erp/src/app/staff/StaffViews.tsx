/**
 * T-387 S7 - the two views of /staff: the lanyard ID-card wall and the live roster. Server components, tokens only
 * (the looks come from docs/design/t387 StaffCards and StaffRoster; no markup or hex is copied).
 *
 * The live chip (`data-live-state`) is drawn only when the page passes `states`, which it does only for a viewer
 * who holds `manage_attendance` at the store (todayStateFor refuses everyone else). No schedule band: there is no
 * shift table to draw one from (t387-q6).
 */
import Link from 'next/link';
import { Badge } from '@/components/ui';
import { PhotoThumb } from '@/components/upload/PhotoThumb';
import { businessDayRange, toBusinessDate } from '@shareat/core/datetime';
import { formatTenure } from './tenure';
import { staffRoleTitle } from './role-title';

export type LiveState = 'on' | 'break' | 'off';
export interface LiveEntry {
  state: LiveState;
  since?: Date;
  firstIn?: Date;
}

export interface StaffPerson {
  role?: string | null;
  id: string;
  displayName: string;
  employmentStatus: string;
  startedOn: string;
  primaryPosition: string | null;
  /** Set only when the viewer may open the photo; otherwise initials are drawn. */
  photoFileId: string | null;
}

const LIVE_LABEL: Record<LiveState, string> = { on: 'On shift', break: 'On break', off: 'Off' };
const LIVE_TONE = { on: 'success', break: 'warning', off: 'closed' } as const;
const RING: Record<LiveState, string> = { on: 'ring-success', break: 'ring-warning', off: 'ring-closed' };
const AVATAR_TONES = [
  'bg-info-soft text-info',
  'bg-success-soft text-success',
  'bg-progress-soft text-progress',
  'bg-warning-soft text-warning-ink',
  'bg-danger-surface text-danger',
  'bg-closed-soft text-closed',
];

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]![0]!;
  const last = words.length > 1 ? words[words.length - 1]![0]! : '';
  return (first + last).toUpperCase();
}

function toneFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length]!;
}

function LiveChip({ entry }: { entry: LiveEntry | undefined }) {
  // A person missing from today's state (hired after it was read) gets no chip, not a guessed "Off".
  if (!entry) return null;
  const state: LiveState = entry.state;
  return (
    <span data-live-state={state} className="inline-flex">
      <Badge tone={LIVE_TONE[state]} label={LIVE_LABEL[state]} />
    </span>
  );
}

function Avatar({ person, className, inLink = false }: { person: StaffPerson; className: string; inLink?: boolean }) {
  if (person.photoFileId) {
    return (
      <PhotoThumb
        purpose="staff_photo"
        label={person.displayName}
        existing={{ fileId: person.photoFileId, kind: 'image' }}
        size="fill"
        className={className}
        inLink={inLink}
      />
    );
  }
  return (
    <span aria-hidden="true" className={`${className} flex items-center justify-center font-display font-extrabold ${toneFor(person.id)}`}>
      {initials(person.displayName)}
    </span>
  );
}

// ---- segmented control --------------------------------------------------------------------------

const SEG_ACTIVE = 'inline-flex min-h-11 items-center rounded-full bg-ink px-4 text-sm font-semibold text-canvas';
const SEG_IDLE = 'inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold text-ink hover:bg-canvas';

export function ViewSwitch({ view, storeId }: { view: 'cards' | 'roster' | 'positions'; storeId: string }) {
  return (
    <nav aria-label="Staff view" className="inline-flex gap-1 rounded-full border border-surface-border bg-surface p-1">
      {view === 'cards' ? (
        <Link href={`/staff?view=cards&store=${storeId}`} aria-current="page" className={SEG_ACTIVE}>
          Cards
        </Link>
      ) : (
        <Link href={`/staff?view=cards&store=${storeId}`} className={SEG_IDLE}>
          Cards
        </Link>
      )}
      {view === 'roster' ? (
        <Link href={`/staff?view=roster&store=${storeId}`} aria-current="page" className={SEG_ACTIVE}>
          Roster
        </Link>
      ) : (
        <Link href={`/staff?view=roster&store=${storeId}`} className={SEG_IDLE}>
          Roster
        </Link>
      )}
      {view === 'positions' ? (
        <Link href={`/staff?view=positions&store=${storeId}`} aria-current="page" className={SEG_ACTIVE}>
          Positions
        </Link>
      ) : (
        <Link href={`/staff?view=positions&store=${storeId}`} className={SEG_IDLE}>
          Positions
        </Link>
      )}
    </nav>
  );
}

// ---- the ID-card wall ---------------------------------------------------------------------------

const CARD_LINK =
  'relative flex min-h-11 w-full flex-col items-center overflow-hidden rounded-[18px] border border-surface-border bg-surface pb-5 text-ink shadow-sm motion-safe:transition-transform motion-safe:hover:-rotate-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas';

export function CardWall({
  people,
  storeName,
  today,
  states,
}: {
  people: StaffPerson[];
  storeName: string;
  today: string;
  states: Record<string, LiveEntry> | null;
}) {
  return (
    <ul data-view="cards" className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-7 gap-y-9">
      {people.map((p) => (
        <li key={p.id} data-staff-card className="flex flex-col items-center">
          <span aria-hidden="true" className="h-8 w-4 rounded-t-sm bg-brand" />
          <span aria-hidden="true" className="-mb-0.5 h-3 w-6 rounded-t-[14px] border-[3px] border-b-0 border-closed" />
          <Link href={`/staff/${p.id}`} className={CARD_LINK}>
            <span aria-hidden="true" className="absolute inset-x-[-10%] top-0 h-24 rounded-b-[50%] bg-brand" />
            <span aria-hidden="true" className="absolute left-1/2 top-2.5 h-2 w-7 -translate-x-1/2 rounded-full bg-canvas opacity-90" />
            <Avatar person={p} inLink className="relative mt-11 h-24 w-24 rounded-full border-4 border-surface text-4xl" />
            <span className="mt-3 px-3 text-center font-display text-xl font-extrabold uppercase leading-tight">{p.displayName}</span>
            <span className="mt-1 text-xs font-bold uppercase tracking-wide text-brand-ink">{staffRoleTitle(p.role, p.primaryPosition)}</span>
            <span className="mt-0.5 text-xs text-muted">
              {storeName} · {formatTenure(p.startedOn, today)}
            </span>
            <span className="mt-1 text-xs capitalize text-muted">{p.employmentStatus.replace(/-/g, ' ')}</span>
            {states ? (
              <span className="mt-3">
                <LiveChip entry={states[p.id]} />
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ---- the live roster ----------------------------------------------------------------------------

const ROW_LINK = 'inline-flex min-h-11 items-center font-semibold text-ink hover:text-brand-ink';
const STRIP_FROM = 6;
const STRIP_SPAN = 18; // 6a .. 12a

/** Percent along the 6a-to-midnight strip for an instant (Manila clock), clamped to the strip. */
function stripPct(at: Date): number {
  // Hours since the start of this instant's business day (Asia/Manila), from the shared datetime helpers
  // rather than a hand-written +8h offset (t374 guard).
  const h = (at.getTime() - businessDayRange(toBusinessDate(at)).start.getTime()) / 3_600_000;
  const shifted = h < STRIP_FROM ? h + 24 : h;
  return Math.max(0, Math.min(100, ((shifted - STRIP_FROM) / STRIP_SPAN) * 100));
}

function DayStrip({ entry, now }: { entry: LiveEntry | undefined; now: Date }) {
  const nowPct = stripPct(now);
  let worked: [number, number] | null = null;
  let brk: [number, number] | null = null;
  if (entry && entry.state !== 'off') {
    const start = stripPct(entry.firstIn ?? entry.since ?? now);
    if (entry.state === 'break') {
      const b = Math.max(start, stripPct(entry.since ?? now));
      worked = [start, b];
      brk = [b, Math.max(b, nowPct)];
    } else {
      worked = [start, Math.max(start, nowPct)];
    }
  }
  return (
    <span className="relative block h-5 rounded-md bg-closed-soft" aria-hidden="true">
      {worked ? (
        <span className="absolute inset-y-[3px] rounded bg-success" style={{ left: `${worked[0]}%`, width: `${worked[1] - worked[0]}%` }} />
      ) : null}
      {brk ? (
        <span className="absolute inset-y-[3px] rounded bg-warning" style={{ left: `${brk[0]}%`, width: `${brk[1] - brk[0]}%` }} />
      ) : null}
      <span className="absolute -inset-y-1.5 w-0.5 bg-brand" style={{ left: `${nowPct}%` }} />
    </span>
  );
}

export function Roster({
  people,
  today,
  now,
  states,
}: {
  people: StaffPerson[];
  today: string;
  now: Date;
  states: Record<string, LiveEntry> | null;
}) {
  const count = (s: LiveState) => (states ? people.filter((p) => (states[p.id]?.state ?? 'off') === s).length : 0);
  return (
    <div data-view="roster" className="space-y-4">
      {states ? (
        <dl className="flex flex-wrap gap-8">
          <div>
            <dd className="font-display text-4xl font-extrabold leading-none text-success">{count('on')}</dd>
            <dt className="text-sm text-muted">on shift</dt>
          </div>
          <div>
            <dd className="font-display text-4xl font-extrabold leading-none text-warning-ink">{count('break')}</dd>
            <dt className="text-sm text-muted">on break</dt>
          </div>
          <div>
            <dd className="font-display text-4xl font-extrabold leading-none">{count('off')}</dd>
            <dt className="text-sm text-muted">off today</dt>
          </div>
        </dl>
      ) : null}
      {states ? (
        <p className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-2.5 w-5 rounded-sm bg-success" />
            Worked
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-2.5 w-5 rounded-sm bg-warning" />
            Break
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-3.5 w-0.5 bg-brand" />
            Now
          </span>
          <span>6a to midnight</span>
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <ul className="min-w-[44rem] divide-y divide-surface-border border-y border-surface-border">
          {people.map((p) => {
            const entry = states?.[p.id];
            const ring = states ? RING[entry?.state ?? 'off'] : 'ring-surface-border';
            return (
              <li key={p.id} className="grid grid-cols-[minmax(12rem,1.4fr)_minmax(14rem,2.4fr)_9rem] items-center gap-5 px-2 py-3 hover:bg-surface">
                <span className="flex min-w-0 items-center gap-3.5">
                  <Avatar person={p} className={`h-11 w-11 shrink-0 rounded-full text-base ring-2 ring-offset-2 ring-offset-canvas ${ring}`} />
                  <span className="flex min-w-0 flex-col">
                    <Link href={`/staff/${p.id}`} className={ROW_LINK}>
                      {p.displayName}
                    </Link>
                    <span className="text-xs text-muted">
                      {staffRoleTitle(p.role, p.primaryPosition)} · {formatTenure(p.startedOn, today)}
                    </span>
                  </span>
                </span>
                {states ? <DayStrip entry={entry} now={now} /> : <span />}
                <span>{states ? <LiveChip entry={entry} /> : null}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
