import { retireStorePositionAction, toggleDefaultAction } from './actions';
import {
  areaOnCount,
  overlapDisclosure,
  type ActiveDefaultsByPosition,
  type GridAreaGroup,
  type GridPosition,
  type GridScopeGroup,
  type OverlapCountsByPosition,
} from './lib';
import { capabilityTitle, type Capability } from '@shareat/auth';

// T-334 slice 3 names `page.tsx` (`:281`) for its local BTN/INPUT sweep — this is this file's own
// local copy, not a shared export, exactly that slice's one-constant-per-file shape. `page.tsx`
// keeps its own copy for its "Same for every store" / "Copy defaults from…" buttons.
const LINK_BTN =
  'rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';

// -------------------------------------------------------------------------------------------
// One immediate toggle per cell. Safe to render twice (desktop + mobile) — see actions.ts.
// -------------------------------------------------------------------------------------------

function ToggleButton({
  storeId,
  positionId,
  capability,
  active,
}: {
  storeId: string;
  positionId: string;
  capability: string;
  active: boolean;
}) {
  return (
    <form action={toggleDefaultAction}>
      <input type="hidden" name="storeId" value={storeId} />
      <input type="hidden" name="positionId" value={positionId} />
      <input type="hidden" name="capability" value={capability} />
      <input type="hidden" name="on" value={active ? 'false' : 'true'} />
      <button
        type="submit"
        aria-pressed={active}
        className={`w-full rounded-md border px-2 py-2 text-xs font-medium ${
          active
            ? 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
            : 'border-neutral-300 bg-white text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400'
        }`}
      >
        {active ? 'On' : 'Off'}
      </button>
    </form>
  );
}

function InheritedBadge() {
  return (
    <span
      title="Every staff member already has this through the role matrix."
      className="flex w-full items-center justify-center rounded-md border border-neutral-200 bg-neutral-100 px-2 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400"
    >
      On (role)
    </span>
  );
}

// -------------------------------------------------------------------------------------------
// T-337 §3 — ONE shared colgroup component. Called with the same `positions` in the header table
// and every area table, so React renders byte-identical markup every time — the mechanism, not a
// convention, behind "columns align because every table is sized from the same component".
// -------------------------------------------------------------------------------------------

function GridColgroup({ positionCount }: { positionCount: number }) {
  return (
    <colgroup>
      <col className="w-64" />
      {Array.from({ length: positionCount }).map((_, i) => (
        <col key={i} />
      ))}
    </colgroup>
  );
}

/** T-337 §3 desktop area summary, second line: "On: Cashier 7 · Cook 0 · …", in column order.
 *  Each `Name N` is its own `whitespace-nowrap` span so a wrap can only happen BETWEEN positions,
 *  never inside one (§3's wrap rule). New markup — tokens only, no `dark:`/`neutral-*`. A store-
 *  invented position carries the same `(this store)` marker the header th spans render (T-337
 *  review fix) — de-emphasised with `text-ink/60` rather than the header's own `dark:`-paired
 *  `neutral-400`, since this is new §3 markup — nested inside the position's own `whitespace-
 *  nowrap` span so it wraps with the name, never between them. */
function OnByPosition({
  positions,
  capabilities,
  activeDefaults,
}: {
  positions: readonly GridPosition[];
  capabilities: GridAreaGroup['capabilities'];
  activeDefaults: ActiveDefaultsByPosition;
}) {
  return (
    <span className="block text-[11px] font-normal text-ink/70">
      On:{' '}
      {positions.map((p, i) => (
        <span key={p.id} className="whitespace-nowrap">
          {i > 0 && ' · '}
          {p.name}
          {!p.isCanonical && <span className="ml-1 text-ink/60">(this store)</span>}{' '}
          {areaOnCount(capabilities, activeDefaults.get(p.id))}
        </span>
      ))}
    </span>
  );
}

// -------------------------------------------------------------------------------------------
// Desktop: a real comparison table — positions across, capabilities down (§C5). `hidden sm:table`.
//
// T-337 §3 — `<details>` cannot live inside a `<table>`, so this becomes: one header table (the
// original `<thead>`, Retire forms included, rendered ONCE), then per SCOPE a `<details open>`
// holding one `<details>` per AREA (never `open`), each with its own `<table>` — a plain-text
// position-name header row (no Retire form), then that area's capability rows. Every table shares
// `GridColgroup`, so the capability column and every position column line up across all of them.
// -------------------------------------------------------------------------------------------

export function DesktopGrid({
  storeId,
  positions,
  groups,
  activeDefaults,
  overlapCounts,
  openCapability,
}: {
  storeId: string;
  positions: readonly GridPosition[];
  groups: readonly GridScopeGroup[];
  activeDefaults: ActiveDefaultsByPosition;
  overlapCounts: OverlapCountsByPosition;
  /** Amendment A1 — reopen the area a toggle's redirect landed on. Undefined/no match ⇒ every
   *  area stays closed, byte-identical to before this prop existed (contract point 4). */
  openCapability?: Capability;
}) {
  return (
    <div className="hidden overflow-x-auto rounded-lg border border-surface-border sm:block">
      <table className="w-full min-w-[640px] table-fixed border-collapse text-sm">
        <GridColgroup positionCount={positions.length} />
        <thead className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
          <tr>
            <th className="px-3 py-2 font-medium">Capability</th>
            {positions.map((p) => (
              <th key={p.id} className="px-3 py-2 font-medium">
                {p.name}
                {!p.isCanonical && <span className="ml-1 text-[10px] text-neutral-400">(this store)</span>}
                <span className="block text-[11px] font-normal text-neutral-500 dark:text-neutral-400">
                  {p.holderCount} holder{p.holderCount === 1 ? '' : 's'}
                </span>
                {!p.isCanonical && (
                  <form action={retireStorePositionAction} className="mt-1">
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="positionId" value={p.id} />
                    {/* T-262 / DEF-269 — a header control still has to clear the 24px touch floor;
                        the first draft was a 10px underlined word and the sweep caught it. Fixed
                        the control, never the baseline (T-290 §C10). */}
                    <button
                      type="submit"
                      className="rounded-md border border-red-300 px-2 py-1 text-xs font-normal text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                    >
                      Retire
                    </button>
                  </form>
                )}
              </th>
            ))}
          </tr>
        </thead>
      </table>

      {groups.map(
        (group) =>
          group.areas.length > 0 && (
            <details key={group.scope} open className="border-t border-surface-border bg-surface">
              <summary className="cursor-pointer px-3 py-1.5 text-xs text-ink">
                <span className="font-medium uppercase tracking-wide">{group.scope}-scoped</span> ·{' '}
                {group.areas.reduce((n, a) => n + a.capabilities.length, 0)} · {group.note}
              </summary>
              {group.areas.map((area) => (
                <details
                  key={area.area}
                  open={openCapability != null && area.capabilities.some((c) => c.capability === openCapability)}
                  className="border-t border-surface-border"
                >
                  <summary className="cursor-pointer px-3 py-1.5 text-xs text-ink">
                    <span className="font-medium">{area.label}</span> · {area.capabilities.length}
                    <OnByPosition positions={positions} capabilities={area.capabilities} activeDefaults={activeDefaults} />
                  </summary>
                  <table className="w-full min-w-[640px] table-fixed border-collapse text-sm">
                    <GridColgroup positionCount={positions.length} />
                    <thead className="border-b border-surface-border bg-surface text-left text-ink">
                      <tr>
                        <th className="px-3 py-2 font-medium">Capability</th>
                        {positions.map((p) => (
                          <th key={p.id} className="px-3 py-2 font-medium">
                            {p.name}
                            {!p.isCanonical && <span className="ml-1 text-[10px] text-ink/60">(this store)</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {area.capabilities.map((cell) => (
                        <tr key={cell.capability} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                          <td className="px-3 py-2 text-xs">
                            <span>{capabilityTitle(cell.capability)}</span>
                            <span className="block font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                              {cell.capability}
                            </span>
                            {cell.inherited && (
                              <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-sans text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                                inherited
                              </span>
                            )}
                          </td>
                          {positions.map((p) => {
                            const active = activeDefaults.get(p.id)?.has(cell.capability) ?? false;
                            const disclosure = active ? null : overlapDisclosure(overlapCounts.get(p.id)?.get(cell.capability) ?? 0);
                            return (
                              <td key={p.id} className="px-2 py-1.5">
                                {cell.inherited ? (
                                  <InheritedBadge />
                                ) : (
                                  <ToggleButton storeId={storeId} positionId={p.id} capability={cell.capability} active={active} />
                                )}
                                {disclosure && (
                                  <p className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">{disclosure}</p>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ))}
            </details>
          ),
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Mobile: one position per section, each capability a full-width touch row (§C5, the
// `settings/sales-channels/page.tsx` Radio idiom). `sm:hidden`.
//
// T-337 §3 — three nesting levels: per-POSITION `<details>` (unchanged, first one open) ▸ per-
// SCOPE `<details open>` ▸ per-AREA `<details>` (never open).
// -------------------------------------------------------------------------------------------

export function MobileSections({
  storeId,
  positions,
  groups,
  activeDefaults,
  overlapCounts,
  openCapability,
  openPositionId,
}: {
  storeId: string;
  positions: readonly GridPosition[];
  groups: readonly GridScopeGroup[];
  activeDefaults: ActiveDefaultsByPosition;
  overlapCounts: OverlapCountsByPosition;
  /** Amendment A1 — same reopen contract as `DesktopGrid.openCapability`, but scoped to the one
   *  position section named by `openPositionId`: other positions' copies of that same area stay
   *  closed. Undefined/no match ⇒ falls back to today's default (first position open). */
  openCapability?: Capability;
  openPositionId?: string;
}) {
  return (
    <div className="space-y-3 sm:hidden">
      {positions.map((p, i) => (
        <details
          key={p.id}
          open={openPositionId != null ? p.id === openPositionId : i === 0}
          className="rounded-lg border border-neutral-200 dark:border-neutral-800"
        >
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            {p.name}
            {!p.isCanonical && <span className="ml-1 text-xs text-neutral-400">(this store)</span>}
            <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
              {p.holderCount} holder{p.holderCount === 1 ? '' : 's'}
            </span>
          </summary>
          <div className="space-y-2 border-t border-neutral-200 p-3 dark:border-neutral-800">
            {groups.map(
              (group) =>
                group.areas.length > 0 && (
                  <details key={group.scope} open className="rounded-lg border border-surface-border bg-surface">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink">
                      {group.scope}-scoped
                    </summary>
                    <p className="px-3 pb-2 text-xs text-ink/70">{group.note}</p>
                    <div className="space-y-2 border-t border-surface-border p-2">
                      {group.areas.map((area) => {
                        const on = areaOnCount(area.capabilities, activeDefaults.get(p.id));
                        const isOpenArea =
                          openPositionId === p.id &&
                          openCapability != null &&
                          area.capabilities.some((c) => c.capability === openCapability);
                        return (
                          <details key={area.area} open={isOpenArea} className="rounded-lg border border-surface-border">
                            <summary className="cursor-pointer px-3 py-2 text-xs text-ink">
                              <span className="font-medium">{area.label}</span> · {on}/{area.capabilities.length} on
                            </summary>
                            <div className="space-y-2 border-t border-surface-border p-2">
                              {area.capabilities.map((cell) => {
                                const active = activeDefaults.get(p.id)?.has(cell.capability) ?? false;
                                const disclosure = active ? null : overlapDisclosure(overlapCounts.get(p.id)?.get(cell.capability) ?? 0);
                                return (
                                  <div key={cell.capability} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                                    <div className="flex items-center justify-between gap-3">
                                      <span className="min-w-0 text-xs">
                                        <span>{capabilityTitle(cell.capability)}</span>
                                        {cell.inherited && (
                                          <span className="ml-2 block font-sans text-[11px] text-neutral-500 dark:text-neutral-400">
                                            Every staff member already has this through the role matrix.
                                          </span>
                                        )}
                                        <span className="block font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                                          {cell.capability}
                                        </span>
                                      </span>
                                      <div className="w-24 shrink-0">
                                        {cell.inherited ? (
                                          <InheritedBadge />
                                        ) : (
                                          <ToggleButton storeId={storeId} positionId={p.id} capability={cell.capability} active={active} />
                                        )}
                                      </div>
                                    </div>
                                    {disclosure && (
                                      <p className="mt-2 text-[11px] font-medium text-amber-700 dark:text-amber-400">{disclosure}</p>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </details>
                ),
            )}
            {!p.isCanonical && (
              <form action={retireStorePositionAction} className="pt-2">
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="positionId" value={p.id} />
                <button type="submit" className={LINK_BTN}>
                  Retire {p.name}
                </button>
              </form>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
