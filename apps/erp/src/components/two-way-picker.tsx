'use client';

/**
 * A "From" / "To" pair of selects that can never both point at the same thing — the mistake is
 * unselectable, not merely rejected after a round trip to the server.
 *
 * ⭐ **Central on purpose.** Every transfer-shaped screen in this app pairs two selects drawn
 * from ONE list — a stock transfer's two rooms (T-167), a money transfer's two accounts — and
 * every one of them already has a domain-level `from === to` refusal
 * (`packages/domain/src/stock/transfer-rules.ts`, `packages/domain/src/money-transfers/index.ts`).
 * That refusal is correct and stays; this component is the UI half, written once so a THIRD
 * transfer screen inherits the fix instead of reintroducing the gap.
 */
import { useState } from 'react';

export interface PickerOption {
  readonly id: string;
  readonly label: string;
  /** Money transfers groups by store — options sharing a `groupLabel` render under one `<optgroup>`. */
  readonly groupLabel?: string;
}

function groupOptions(options: readonly PickerOption[]): { label: string | null; options: PickerOption[] }[] {
  const groups: { label: string | null; options: PickerOption[] }[] = [];
  const byLabel = new Map<string | null, PickerOption[]>();
  for (const opt of options) {
    const key = opt.groupLabel ?? null;
    const list = byLabel.get(key);
    if (list) list.push(opt);
    else {
      const fresh = [opt];
      byLabel.set(key, fresh);
      groups.push({ label: key, options: fresh });
    }
  }
  return groups;
}

function Options({ options, exclude }: { options: readonly PickerOption[]; exclude?: string }) {
  const visible = exclude ? options.filter((o) => o.id !== exclude) : options;
  const groups = groupOptions(visible);
  return (
    <>
      {groups.map((g) =>
        g.label === null ? (
          g.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))
        ) : (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </>
  );
}

export function TwoWayPicker({
  options,
  fromName,
  toName,
  fromLabel = 'From',
  toLabel = 'To',
  /** Money transfers wants a forced explicit choice; a stock transfer wants a sane default.
   *  Set to require BOTH selects to start blank, showing this text as the placeholder option. */
  blankPlaceholder,
  selectClassName,
  labelClassName,
}: {
  options: readonly PickerOption[];
  fromName: string;
  toName: string;
  fromLabel?: string;
  toLabel?: string;
  blankPlaceholder?: string;
  selectClassName?: string;
  labelClassName?: string;
}) {
  const firstTwoDistinct = blankPlaceholder
    ? ['', '']
    : [options[0]?.id ?? '', options.find((o) => o.id !== options[0]?.id)?.id ?? ''];
  const [from, setFrom] = useState(firstTwoDistinct[0]!);
  const [to, setTo] = useState(firstTwoDistinct[1]!);

  // ⭐ ONE-DIRECTIONAL filtering, deliberately not both ways: "From" always offers every option,
  // "To" excludes whatever "From" currently is. Filtering BOTH lists looked more symmetric but
  // deadlocks the two-option case — with exactly two rooms, each list would have only its own
  // current value left, so neither field could ever be changed to the other's value and the
  // direction could never be reversed. Bumping "To" off a value "From" just took over the only
  // no-deadlock way to keep the invariant.
  function onFromChange(next: string) {
    setFrom(next);
    if (next && next === to) {
      const other = options.find((o) => o.id !== next);
      setTo(other?.id ?? '');
    }
  }

  return (
    <>
      <label className={labelClassName}>
        {fromLabel}
        <select
          name={fromName}
          required
          value={from}
          onChange={(e) => onFromChange(e.target.value)}
          className={selectClassName}
        >
          {blankPlaceholder && <option value="">{blankPlaceholder}</option>}
          <Options options={options} />
        </select>
      </label>
      <label className={labelClassName}>
        {toLabel}
        <select
          name={toName}
          required
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className={selectClassName}
        >
          {blankPlaceholder && <option value="">{blankPlaceholder}</option>}
          {/* ⭐ The thing already picked as "From" is not offered here at all. */}
          <Options options={options} exclude={from} />
        </select>
      </label>
    </>
  );
}
