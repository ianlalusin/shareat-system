
"use client";

import React, { useMemo, useState } from "react";

type Preset = "yesterday" | "today" | "lastWeek" | "lastMonth" | "lastYear" | "custom";
type DateRange = { start: Date; end: Date };

function atStartOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function atEndOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}
function addMonths(d: Date, months: number) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + months);
  return x;
}
function startOfWeek(d: Date, weekStartsOn: 0 | 1 = 0) {
  const x = atStartOfDay(d);
  const day = x.getDay(); // 0=Sun
  const diff = (day - weekStartsOn + 7) % 7;
  return addDays(x, -diff);
}
function clampRange(a: Date, b: Date): DateRange {
  return a.getTime() <= b.getTime() ? { start: a, end: b } : { start: b, end: a };
}
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function sameRange(a: DateRange, b: DateRange) {
  return sameDay(a.start, b.start) && sameDay(a.end, b.end);
}
function inRange(d: Date, r: DateRange) {
  const t = d.getTime();
  return t >= atStartOfDay(r.start).getTime() && t <= atEndOfDay(r.end).getTime();
}
function fmtMonthYear(d: Date) {
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}

const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Date(2000, i, 1).toLocaleString(undefined, { month: "long" })
);
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export default function CompactCalendar({
  weekStartsOn = 0,
  accent = "#16a34a", // green-600
  initialPreset = "today",
  selectionMode = "range",
  showPresets = true,
  showActions = true,
  onChange,
}: {
  weekStartsOn?: 0 | 1;
  accent?: string;
  initialPreset?: Preset;
  selectionMode?: "range" | "single";
  showPresets?: boolean;
  showActions?: boolean;
  onChange?: (range: DateRange, preset: Preset) => void;
}) {
  const today = useMemo(() => atStartOfDay(new Date()), []);
  const initial = useMemo(() => presetToRange(initialPreset, today), [initialPreset, today]);

  // committed (locked) values
  const [preset, setPreset] = useState<Preset>(initialPreset);
  const [range, setRange] = useState<DateRange>(initial);

  // pending (unlocked) values
  const [pendingPreset, setPendingPreset] = useState<Preset>(initialPreset);
  const [pendingRange, setPendingRange] = useState<DateRange>(initial);

  const [displayDate, setDisplayDate] = useState<Date>(atStartOfDay(initial.end));

  // Click-cycle:
  // 1st click => single date (start=end)
  // 2nd click => range (start..end)
  // 3rd click => reset to single date again (start=end=clicked)
  const [clickPhase, setClickPhase] = useState<0 | 1>(0);
  const [anchor, setAnchor] = useState<Date | null>(null);

  const years = useMemo(() => {
    const y = new Date().getFullYear();
    const start = y - 10;
    const end = y + 2;
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }, []);

  const gridStart = useMemo(() => {
    const firstOfMonth = new Date(displayDate.getFullYear(), displayDate.getMonth(), 1);
    return startOfWeek(firstOfMonth, weekStartsOn);
  }, [displayDate, weekStartsOn]);

  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart]);


  const monthIdx = displayDate.getMonth();
  const yearVal = displayDate.getFullYear();

  const canApply = !sameRange(range, pendingRange) || preset !== pendingPreset;

  function applyPending() {
    // Apply must commit + notify parent (fix “Apply does nothing”)
    setRange(pendingRange);
    setPreset(pendingPreset);
    onChange?.(pendingRange, pendingPreset);

    // After apply, keep click behavior predictable:
    // treat current selection as "single" if start=end else "range chosen".
    // Next click should reset to single date (your requirement: 3rd click resets).
    setClickPhase(0);
    setAnchor(null);
  }

  function cancelPending() {
    setPendingRange(range);
    setPendingPreset(preset);
    setClickPhase(0);
    setAnchor(null);
    setDisplayDate(atStartOfDay(range.end));
  }

  function applyPreset(p: Preset) {
    const next = presetToRange(p, today);
    setPendingPreset(p);
    setPendingRange(next);
    setDisplayDate(atStartOfDay(next.end));

    // Preset selections count as “committed candidate”, so next click starts fresh.
    setClickPhase(0);
    setAnchor(null);
  }

  function onPickDay(d: Date) {
    if (selectionMode === "single") {
      const single = atStartOfDay(d);
      const singleRange = { start: single, end: single };
      setPendingPreset("custom");
      setPendingRange(singleRange);
      // Immediately commit for single mode
      setRange(singleRange);
      setPreset("custom");
      onChange?.(singleRange, "custom");
      setClickPhase(0);
      setAnchor(null);
      return;
    }
    
    // Any click forces custom mode
    setPendingPreset("custom");

    // Phase 0: first click => single date (start=end)
    if (clickPhase === 0) {
      const single = atStartOfDay(d);
      setAnchor(single);
      setPendingRange({ start: single, end: single });
      setClickPhase(1); // next click will form a range
      setDisplayDate(single);
      return;
    }

    // Phase 1: second click => range using anchor..clicked
    if (anchor) {
      const end = atStartOfDay(d);
      const next = clampRange(anchor, end);
      setPendingRange(next);
      setDisplayDate(atStartOfDay(next.end));

      // After forming a range, next click must RESET to single date (your rule)
      setClickPhase(0);
      setAnchor(null);
      return;
    }

    // Safety fallback (should not happen): treat as first click
    const single = atStartOfDay(d);
    setAnchor(single);
    setPendingRange({ start: single, end: single });
    setClickPhase(1);
    setDisplayDate(single);
  }

  function setMonth(m: number) {
    const next = new Date(displayDate);
    next.setMonth(m);
    setDisplayDate(next);
  }
  function setYear(y: number) {
    const next = new Date(displayDate);
    next.setFullYear(y);
    setDisplayDate(next);
  }
  function prevMonth() {
    setDisplayDate((d) => addMonths(d, -1));
  }
  function nextMonth() {
    setDisplayDate((d) => addMonths(d, 1));
  }

  return (
    <div
      className="w-full max-w-[520px] rounded-2xl border bg-white p-2 sm:p-3"
      style={{ ["--accent" as any]: accent } as React.CSSProperties}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={prevMonth}
          className="rounded-md px-2 py-1 text-lg font-bold hover:bg-black/5 active:bg-black/10"
          aria-label="Previous month"
          style={{ color: "var(--accent)", fontWeight: 400 }}
        >
          ‹
        </button>

        <div className="min-w-0 flex-1">
          <div className="truncate text-center text-[clamp(12px,2.2vw,16px)]" style={{ fontWeight: 400 }}>
            {fmtMonthYear(displayDate)}
          </div>

          <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
            <select
              value={monthIdx}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="rounded-md border px-2 py-1 text-[clamp(11px,1.8vw,13px)] outline-none focus:ring-2"
              style={{ fontWeight: 400, borderColor: "rgba(0,0,0,0.15)" }}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i}>
                  {m}
                </option>
              ))}
            </select>

            <select
              value={yearVal}
              onChange={(e) => setYear(Number(e.target.value))}
              className="rounded-md border px-2 py-1 text-[clamp(11px,1.8vw,13px)] outline-none focus:ring-2"
              style={{ fontWeight: 400, borderColor: "rgba(0,0,0,0.15)" }}
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="button"
          onClick={nextMonth}
          className="rounded-md px-2 py-1 text-lg font-bold hover:bg-black/5 active:bg-black/10"
          aria-label="Next month"
          style={{ color: "var(--accent)", fontWeight: 400 }}
        >
          ›
        </button>
      </div>

      {/* Presets */}
      {showPresets && (
        <div className="mt-2 flex flex-wrap gap-1.5">
            <PresetBtn label="Yesterday" active={pendingPreset === "yesterday"} onClick={() => applyPreset("yesterday")} />
            <PresetBtn label="Today" active={pendingPreset === "today"} onClick={() => applyPreset("today")} />
            <PresetBtn label="Last week" active={pendingPreset === "lastWeek"} onClick={() => applyPreset("lastWeek")} />
            <PresetBtn label="Last month" active={pendingPreset === "lastMonth"} onClick={() => applyPreset("lastMonth")} />
            <PresetBtn label="Last year" active={pendingPreset === "lastYear"} onClick={() => applyPreset("lastYear")} />
            <PresetBtn label="Custom" active={pendingPreset === "custom"} onClick={() => setPendingPreset("custom")} />
        </div>
      )}
      

      {/* Calendar */}
      <div className="mt-2">
        <div className="grid grid-cols-7 gap-[2px] text-center text-[clamp(10px,1.6vw,12px)] text-black/70">
          {DOW.map((d) => (
            <div key={d} className="py-1" style={{ fontWeight: 400 }}>
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-[2px]">
          {days.map((d) => {
            const isInDisplayedMonth = d.getMonth() === displayDate.getMonth();
            const isSelectedStart = sameDay(d, pendingRange.start);
            const isSelectedEnd = sameDay(d, pendingRange.end);
            const isInside = inRange(d, pendingRange);

            return (
              <button
                key={d.toISOString()}
                type="button"
                onClick={() => onPickDay(d)}
                className="h-[clamp(20px,4.2vw,28px)] rounded-md text-[clamp(11px,2vw,13px)] outline-none"
                style={{
                  fontWeight: 400,
                  opacity: isInDisplayedMonth ? 1 : 0.45,
                  background:
                    isSelectedStart || isSelectedEnd
                      ? "var(--accent)"
                      : isInside
                      ? "color-mix(in oklab, var(--accent) 15%, white)"
                      : "transparent",
                  color: isSelectedStart || isSelectedEnd ? "white" : "inherit",
                }}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>

        {/* Apply / Cancel */}
        {showActions && (
            <div className="mt-2 flex items-center justify-between gap-2">
                <div className="text-[clamp(10px,1.6vw,12px)] text-black/60" style={{ fontWeight: 400 }}>
                    {pendingRange.start.toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" })} —{" "}
                    {pendingRange.end.toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" })}
                    {clickPhase === 1 ? " (tap end date)" : ""}
                </div>

                <div className="flex items-center gap-1.5">
                    <button
                    type="button"
                    onClick={cancelPending}
                    className="rounded-md border px-2 py-1 text-[clamp(11px,1.8vw,13px)] hover:bg-black/5 active:bg-black/10"
                    style={{ fontWeight: 400, borderColor: "rgba(0,0,0,0.15)" }}
                    disabled={!canApply}
                    >
                    Cancel
                    </button>
                    <button
                    type="button"
                    onClick={applyPending}
                    className="rounded-md px-2 py-1 text-[clamp(11px,1.8vw,13px)] text-white disabled:opacity-50"
                    style={{ fontWeight: 400, background: "var(--accent)" }}
                    disabled={!canApply}
                    >
                    Apply
                    </button>
                </div>
            </div>
        )}
      </div>
    </div>
  );
}

function PresetBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border px-2 py-1 text-[clamp(11px,1.8vw,13px)] hover:bg-black/5 active:bg-black/10"
      style={{
        fontWeight: 400,
        borderColor: active ? "var(--accent)" : "rgba(0,0,0,0.15)",
        color: active ? "var(--accent)" : "inherit",
      }}
    >
      {label}
    </button>
  );
}

function presetToRange(p: Preset, todayStart: Date): DateRange {
  const t = atStartOfDay(todayStart);

  if (p === "yesterday") {
    const y = addDays(t, -1);
    return { start: y, end: y };
  }
  if (p === "today") return { start: t, end: t };

  if (p === "lastWeek") return { start: addDays(t, -6), end: t };
  if (p === "lastMonth") return { start: addDays(t, -29), end: t };
  if (p === "lastYear") return { start: addDays(t, -364), end: t };

  return { start: t, end: t };
}