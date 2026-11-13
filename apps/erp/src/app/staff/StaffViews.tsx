/**
 * T-387 S7 - the two views of /staff: the lanyard ID-card wall and the live roster. Server components, tokens only
 * (the looks come from docs/design/t387 StaffCards and StaffRoster; no markup or hex is copied).
 *
 * The live chip (`data-live-state`) is drawn only when the page passes `states`, which it does only for a viewer
 * who holds `manage_attendance` at the store (todayStateFor refuses everyone else). No schedule band: there is no
 * shift table to draw one from (t387-q6).
 */
import Link from 'next/link';
import { Badge, LinkRow, RowLink, Table, Td, Th } from '@/components/ui';
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
// Off is the ordinary state, not an alarm: a neutral ring reads as "nothing to see".
const RING: Record<LiveState, string> = { on: 'ring-success', break: 'ring-warning', off: 'ring-surface-border' };
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
  'relative flex h-full min-h-[9.5rem] w-full flex-col overflow-hidden rounded-[20px] border border-surface-border bg-surface text-ink shadow-sm motion-safe:transition motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas';

/** Group cards by the question a manager is asking: who is in today, or what they do. */
function cardBuckets(people: StaffPerson[], states: Record<string, LiveEntry> | null) {
  if (states) {
    const order: LiveState[] = ['on', 'break', 'off'];
    const labels: Record<LiveState, string> = { on: 'On shift', break: 'On break', off: 'Off today' };
    return order.map((state) => ({
      key: state,
      label: labels[state],
      people: people.filter((p) => (states[p.id]?.state ?? 'off') === state),
    }));
  }
  const groups = new Map<string, StaffPerson[]>();
  for (const person of people) {
    // Group by the same role-first title the card shows. A manager who happens to hold a
    // "Cashier" position must not be filed under Cashier.
    const key = staffRoleTitle(person.role, person.primaryPosition);
    groups.set(key, [...(groups.get(key) ?? []), person]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => ({ key, label: key, people: rows }));
}

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
  const buckets = cardBuckets(people, states).filter((bucket) => bucket.people.length > 0);
  if (buckets.length === 0) {
    return <p data-view="cards" className="text-sm text-muted">Nobody is on this store&rsquo;s roster yet.</p>;
  }
  return (
    <div data-view="cards" className="space-y-7">
      {buckets.map((bucket) => (
        <section key={bucket.key} aria-labelledby={`staff-card-group-${bucket.key}`}>
          <div className="mb-3 flex items-baseline gap-2">
            <h2 id={`staff-card-group-${bucket.key}`} className="text-sm font-semibold text-ink">
              {bucket.label}
            </h2>
            <span className="text-xs tabular-nums text-muted">{bucket.people.length}</span>
          </div>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {bucket.people.map((p) => {
              const entry = states?.[p.id];
              const ring = states ? RING[entry?.state ?? 'off'] : 'ring-surface-border';
              return (
                <li key={p.id} data-staff-card>
                  <Link href={`/staff/${p.id}`} className={CARD_LINK}>
                    {/* The two ID-card cues: a brand band and a punched slot. */}
                    <span aria-hidden="true" className="h-1.5 w-full bg-brand" />
                    <span
                      aria-hidden="true"
                      className="absolute left-1/2 top-1 h-1.5 w-7 -translate-x-1/2 rounded-full bg-canvas/85"
                    />
                    <div className="flex flex-1 items-start gap-4 p-4">
                      <Avatar
                        person={p}
                        inLink
                        className={`h-16 w-16 shrink-0 rounded-2xl text-2xl ring-2 ring-offset-2 ring-offset-surface ${ring}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <span className="min-w-0 font-display text-lg font-extrabold uppercase leading-tight">
                            {p.displayName}
                          </span>
                          {states ? <LiveChip entry={entry} /> : null}
                        </div>
                        <span className="mt-1 block text-xs font-bold uppercase tracking-wide text-brand-ink">
                          {staffRoleTitle(p.role, p.primaryPosition)}
                        </span>
                        <span className="mt-2 block text-xs text-muted">
                          {storeName} · {formatTenure(p.startedOn, today)}
                        </span>
                        <span className="mt-0.5 block text-xs capitalize text-muted">
                          {p.employmentStatus.replace(/-/g, ' ')}
                        </span>
                      </div>
                    </div>
                    <div className="mt-auto flex items-center justify-between border-t border-surface-border px-4 py-2 text-[11px] uppercase tracking-wide text-muted">
                      <span>ID card</span>
                      <span className="normal-case tracking-normal text-brand-ink">View profile →</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---- the live roster ----------------------------------------------------------------------------

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
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-[20px] border border-surface-border bg-surface-border sm:max-w-lg">
          {[
            { key: 'on' as const, label: 'on shift', tone: 'text-success' },
            { key: 'break' as const, label: 'on break', tone: 'text-warning-ink' },
            { key: 'off' as const, label: 'off today', tone: 'text-ink' },
          ].map((stat) => (
            <div key={stat.key} className="bg-surface px-4 py-3">
              <dd className={`font-display text-3xl font-extrabold leading-none tabular-nums ${stat.tone}`}>{count(stat.key)}</dd>
              <dt className="mt-1 text-xs text-muted">{stat.label}</dt>
            </div>
          ))}
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
      {/* Table on a wide screen; the shared phone annotator turns each row into a card below md. */}
      <Table card={{ title: 'Person', subtitle: 'Position', keys: states ? ['Status'] : undefined }}>
        <thead>
          <tr>
            <Th className="w-14">Photo</Th>
            <Th>Person</Th>
            <Th>Position</Th>
            {states ? <Th className="w-[38%]">Today</Th> : null}
            {states ? <Th className="w-32">Status</Th> : null}
          </tr>
        </thead>
        <tbody>
          {people.map((p) => {
            const entry = states?.[p.id];
            const ring = states ? RING[entry?.state ?? 'off'] : 'ring-surface-border';
            return (
              <LinkRow key={p.id} className="align-middle">
                <Td aria-label="Photo">
                  <Avatar
                    person={p}
                    className={`h-10 w-10 rounded-full text-sm ring-2 ring-offset-2 ring-offset-surface ${ring}`}
                  />
                </Td>
                <Td>
                  <RowLink href={`/staff/${p.id}`}>{p.displayName}</RowLink>
                </Td>
                <Td>
                  <div className="flex min-w-0 flex-col">
                    <span className="text-sm">
                      {staffRoleTitle(p.role, p.primaryPosition)} · {formatTenure(p.startedOn, today)}
                    </span>
                    <span className="text-xs capitalize text-muted">
                      {p.employmentStatus.replace(/-/g, ' ')}
                    </span>
                  </div>
                </Td>
                {states ? (
                  <Td aria-label="Today">
                    <DayStrip entry={entry} now={now} />
                  </Td>
                ) : null}
                {states ? (
                  <Td aria-label="Status">
                    <LiveChip entry={entry} />
                  </Td>
                ) : null}
              </LinkRow>
            );
          })}
        </tbody>
      </Table>
      {people.length === 0 ? (
        <p className="text-sm text-muted">Nobody is on this store&rsquo;s roster yet.</p>
      ) : null}
    </div>
  );
}
