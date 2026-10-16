"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { collection, doc, getDoc, getDocs, query, where, orderBy, limit as fsLimit } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { DailyMetric } from "@/lib/types";

export type DataAnalysisRange =
  | { kind: "allTime" }
  | { kind: "year"; year: number }
  | { kind: "thisMonth" }
  | { kind: "lastMonth" }
  | { kind: "custom"; start: Date; end: Date };

export type DayRow = { dayId: string; date: Date; net: number; tx: number };
export type MonthRow = { monthId: string; label: string; net: number; tx: number };

export type DataAnalysisResult = {
  isLoading: boolean;
  error: string | null;
  availableYears: number[];
  totals: {
    netSales: number;
    grossSales: number;
    txCount: number;
    dineInSessions: number;
    walkInSessions: number;
    totalGuests: number;
    avgBasket: number;
    avgDineInSessionMs: number;
  };
  modeSplit: {
    byMonth: Array<{ monthId: string; monthLabel: string; dineIn: number; walkIn: number }>;
    salesShare: { dineIn: number; walkIn: number };
    sessionShare: { dineIn: number; walkIn: number };
  };
  salesOverTime: {
    byMonth: Array<{ monthId: string; monthLabel: string; net: number; tx: number }>;
    byDay: Array<DayRow> | null;
  };
  comparative: {
    current: { netSales: number; tx: number; dineInShare: number; guests: number };
    previous: { netSales: number; tx: number; dineInShare: number; guests: number };
    yoyByMonth: Array<{ monthLabel: string; thisYear: number; lastYear: number }>;
  };
  bestWorst: {
    days: { best: DayRow[]; worst: DayRow[] };
    months: { best: MonthRow[]; worst: MonthRow[] };
  };
  bestTime: {
    matrix: number[][]; // [dow 0..6][hour 0..23] -> total sales per slot in range
    countMatrix: number[][];
  };
  salesByDow: Array<{ dow: number; label: string; net: number; sessions: number }>;
  topSellers: {
    packages: Array<{ name: string; qty: number; amount: number }>;
    addons: Array<{ name: string; qty: number; amount: number; categoryName: string }>;
    refills: Array<{ name: string; qty: number }>;
  };
  refresh: () => void;
};

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthIdLabel(monthId: string): string {
  const y = monthId.slice(0, 4);
  const m = parseInt(monthId.slice(4, 6), 10);
  return `${MONTH_LABELS[m - 1] || "?"} ${y}`;
}

function dayIdToDate(dayId: string): Date {
  const y = parseInt(dayId.slice(0, 4), 10);
  const m = parseInt(dayId.slice(4, 6), 10) - 1;
  const d = parseInt(dayId.slice(6, 8), 10);
  return new Date(y, m, d);
}

function ymd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function ym(date: Date): string {
  return ymd(date).slice(0, 6);
}

function diffDays(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function sumMetric(metrics: DailyMetric[], key: (m: DailyMetric) => number): number {
  return metrics.reduce((acc, m) => acc + (key(m) || 0), 0);
}

type Aggregate = {
  netSales: number;
  grossSales: number;
  txCount: number;
  dineInSessions: number;
  walkInSessions: number;
  totalGuests: number;
  dineInDurationMsSum: number;
  dineInDurationCount: number;
  salesByMode: { dineIn: number; walkIn: number };
  sessionsByMode: { dineIn: number; walkIn: number };
  salesByHourByMode: { dineIn: Record<string, number>; walkIn: Record<string, number> };
  sessionByHourByMode: { dineIn: Record<string, number>; walkIn: Record<string, number> };
  salesByDow: Record<string, number>;
  sessionsByDow: Record<string, number>;
  packages: Map<string, { qty: number; amount: number }>;
  addons: Map<string, { qty: number; amount: number; categoryName: string }>;
  refills: Map<string, number>;
};

function emptyAggregate(): Aggregate {
  return {
    netSales: 0,
    grossSales: 0,
    txCount: 0,
    dineInSessions: 0,
    walkInSessions: 0,
    totalGuests: 0,
    dineInDurationMsSum: 0,
    dineInDurationCount: 0,
    salesByMode: { dineIn: 0, walkIn: 0 },
    sessionsByMode: { dineIn: 0, walkIn: 0 },
    salesByHourByMode: { dineIn: {}, walkIn: {} },
    sessionByHourByMode: { dineIn: {}, walkIn: {} },
    salesByDow: {},
    sessionsByDow: {},
    packages: new Map(),
    addons: new Map(),
    refills: new Map(),
  };
}

function foldMetric(agg: Aggregate, m: DailyMetric) {
  agg.netSales += (m.payments?.totalGross || 0) - (m.payments?.discountsTotal || 0) - (m.payments?.chargesTotal || 0);
  agg.grossSales += m.payments?.totalGross || 0;
  agg.txCount += m.payments?.txCount || 0;

  const closedByMode = m.sessions?.closedCountByMode;
  if (closedByMode) {
    agg.dineInSessions += closedByMode.dineIn || 0;
    agg.walkInSessions += closedByMode.walkIn || 0;
  } else {
    // Fallback for pre-backfill docs: attribute all to walk-in unknown
    // (We don't know the split; leave both at 0 to avoid misleading numbers.)
  }
  agg.totalGuests += m.guests?.guestCountFinalTotal || 0;
  agg.dineInDurationMsSum += m.sessions?.dineInDurationMsSum || 0;
  agg.dineInDurationCount += m.sessions?.dineInDurationCount || 0;

  const salesByMode = m.sales?.salesAmountByMode;
  if (salesByMode) {
    agg.salesByMode.dineIn += salesByMode.dineIn || 0;
    agg.salesByMode.walkIn += salesByMode.walkIn || 0;
  }
  const txByMode = m.payments?.txCountByMode;
  if (txByMode) {
    agg.sessionsByMode.dineIn += txByMode.dineIn || 0;
    agg.sessionsByMode.walkIn += txByMode.walkIn || 0;
  }

  const sahbm = m.sales?.salesAmountByHourByMode;
  const schbm = m.sales?.sessionCountByHourByMode;
  for (const mode of ["dineIn", "walkIn"] as const) {
    const sa = sahbm?.[mode] || {};
    const sc = schbm?.[mode] || {};
    for (const [h, v] of Object.entries(sa)) {
      agg.salesByHourByMode[mode][h] = (agg.salesByHourByMode[mode][h] || 0) + (v || 0);
    }
    for (const [h, v] of Object.entries(sc)) {
      agg.sessionByHourByMode[mode][h] = (agg.sessionByHourByMode[mode][h] || 0) + (v || 0);
    }
  }

  const sbd = m.sales?.salesAmountByDow || {};
  for (const [dk, v] of Object.entries(sbd)) {
    agg.salesByDow[dk] = (agg.salesByDow[dk] || 0) + (v || 0);
  }
  const scbd = m.sales?.sessionCountByDow || {};
  for (const [dk, v] of Object.entries(scbd)) {
    agg.sessionsByDow[dk] = (agg.sessionsByDow[dk] || 0) + (v || 0);
  }

  const pkgs = m.sales?.packageSalesAmountByName || {};
  const pkgQ = m.sales?.packageSalesQtyByName || {};
  for (const [name, amount] of Object.entries(pkgs)) {
    const prev = agg.packages.get(name) || { qty: 0, amount: 0 };
    prev.amount += amount || 0;
    prev.qty += pkgQ[name] || 0;
    agg.packages.set(name, prev);
  }

  const addonItems = m.sales?.addonSalesByItem || {};
  for (const [name, data] of Object.entries(addonItems)) {
    const prev = agg.addons.get(name) || { qty: 0, amount: 0, categoryName: data.categoryName || "Uncategorized" };
    prev.qty += data.qty || 0;
    prev.amount += data.amount || 0;
    prev.categoryName = data.categoryName || prev.categoryName;
    agg.addons.set(name, prev);
  }

  const refillNames = m.refills?.servedRefillsByName || {};
  for (const [name, qty] of Object.entries(refillNames)) {
    agg.refills.set(name, (agg.refills.get(name) || 0) + (qty || 0));
  }
}

const cache = new Map<string, { value: DataAnalysisResult; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function rangeKey(storeId: string, range: DataAnalysisRange): string {
  if (range.kind === "allTime") return `${storeId}:allTime`;
  if (range.kind === "year") return `${storeId}:year:${range.year}`;
  if (range.kind === "thisMonth") {
    const n = new Date();
    return `${storeId}:thisMonth:${n.getFullYear()}-${n.getMonth() + 1}`;
  }
  if (range.kind === "lastMonth") {
    const n = new Date();
    const lm = new Date(n.getFullYear(), n.getMonth() - 1, 1);
    return `${storeId}:lastMonth:${lm.getFullYear()}-${lm.getMonth() + 1}`;
  }
  return `${storeId}:custom:${range.start.getTime()}-${range.end.getTime()}`;
}

function monthRangeDates(year: number, monthIdx0: number): { start: Date; end: Date } {
  return {
    start: new Date(year, monthIdx0, 1),
    end: new Date(year, monthIdx0 + 1, 0),
  };
}

async function fetchYearDocs(storeId: string): Promise<Array<{ yearId: string; metric: DailyMetric }>> {
  const snap = await getDocs(collection(db, "stores", storeId, "analyticsYears"));
  return snap.docs.map(d => ({ yearId: d.id, metric: d.data() as DailyMetric }));
}

async function fetchMonthDocs(storeId: string, monthIds: string[]): Promise<Array<{ monthId: string; metric: DailyMetric }>> {
  if (monthIds.length === 0) return [];
  const reads = await Promise.all(
    monthIds.map(id => getDoc(doc(db, "stores", storeId, "analyticsMonths", id)))
  );
  return reads
    .map((snap, i) => ({ monthId: monthIds[i], metric: snap.exists() ? (snap.data() as DailyMetric) : null }))
    .filter((r): r is { monthId: string; metric: DailyMetric } => r.metric !== null);
}

async function fetchDailyDocsForRange(storeId: string, start: Date, end: Date): Promise<Array<{ dayId: string; metric: DailyMetric }>> {
  // Use the same range strategy as use-dashboard-analytics.ts.
  const startMs = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const endNextDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getTime();
  const q = query(
    collection(db, "stores", storeId, "analytics"),
    where("meta.dayStartMs", ">=", startMs),
    where("meta.dayStartMs", "<", endNextDay)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ dayId: d.id, metric: d.data() as DailyMetric }));
}

async function fetchAllMonthDocs(storeId: string): Promise<Array<{ monthId: string; metric: DailyMetric }>> {
  const snap = await getDocs(collection(db, "stores", storeId, "analyticsMonths"));
  return snap.docs.map(d => ({ monthId: d.id, metric: d.data() as DailyMetric }));
}

function enumMonthIds(start: Date, end: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const stop = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor.getTime() <= stop.getTime()) {
    out.push(ym(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return out;
}

function resolveRangeDates(range: DataAnalysisRange, knownMonthIds: string[]): { start: Date; end: Date } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range.kind === "year") {
    return { start: new Date(range.year, 0, 1), end: new Date(range.year, 11, 31) };
  }
  if (range.kind === "thisMonth") {
    return monthRangeDates(now.getFullYear(), now.getMonth());
  }
  if (range.kind === "lastMonth") {
    const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return monthRangeDates(lm.getFullYear(), lm.getMonth());
  }
  if (range.kind === "custom") {
    return { start: range.start, end: range.end };
  }
  // allTime: derive from known month IDs
  if (knownMonthIds.length === 0) {
    return { start: today, end: today };
  }
  const sorted = [...knownMonthIds].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const startY = parseInt(first.slice(0, 4), 10);
  const startM = parseInt(first.slice(4, 6), 10) - 1;
  const endY = parseInt(last.slice(0, 4), 10);
  const endM = parseInt(last.slice(4, 6), 10) - 1;
  const endDate = new Date(endY, endM + 1, 0);
  return { start: new Date(startY, startM, 1), end: endDate };
}

export function useDataAnalysis(storeId: string | null | undefined, range: DataAnalysisRange) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DataAnalysisResult | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    if (storeId) cache.delete(rangeKey(storeId, range));
    setNonce(n => n + 1);
  }, [storeId, range]);

  useEffect(() => {
    if (!storeId) {
      setIsLoading(false);
      return;
    }
    const key = rangeKey(storeId, range);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setResult(cached.value);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        // 1) Year docs to derive available years (and quick all-time totals if needed)
        const yearDocs = await fetchYearDocs(storeId);
        const availableYears = yearDocs.map(y => parseInt(y.yearId, 10)).filter(y => !Number.isNaN(y)).sort();

        // 2) Resolve range start/end
        let monthDocs: Array<{ monthId: string; metric: DailyMetric }>;
        let allMonthIdsForRange: string[];
        let dailyDocs: Array<{ dayId: string; metric: DailyMetric }> = [];

        if (range.kind === "allTime") {
          // Fetch every month doc, derive range from them
          monthDocs = await fetchAllMonthDocs(storeId);
          allMonthIdsForRange = monthDocs.map(m => m.monthId);
        } else if (range.kind === "year") {
          allMonthIdsForRange = Array.from({ length: 12 }, (_, i) => `${range.year}${String(i + 1).padStart(2, "0")}`);
          monthDocs = await fetchMonthDocs(storeId, allMonthIdsForRange);
        } else if (range.kind === "thisMonth" || range.kind === "lastMonth") {
          const now = new Date();
          const ref = range.kind === "thisMonth"
            ? new Date(now.getFullYear(), now.getMonth(), 1)
            : new Date(now.getFullYear(), now.getMonth() - 1, 1);
          allMonthIdsForRange = [`${ref.getFullYear()}${String(ref.getMonth() + 1).padStart(2, "0")}`];
          monthDocs = await fetchMonthDocs(storeId, allMonthIdsForRange);
        } else {
          allMonthIdsForRange = enumMonthIds(range.start, range.end);
          monthDocs = await fetchMonthDocs(storeId, allMonthIdsForRange);
        }

        const { start: rangeStart, end: rangeEnd } = resolveRangeDates(range, allMonthIdsForRange);
        const dayCount = diffDays(rangeStart, rangeEnd) + 1;
        const canShowByDay = dayCount > 0 && dayCount <= 90;

        // A custom range can start/end mid-month, so the whole-month rollups
        // would over-count it (e.g. "Jun 5–10" must NOT pull in all of June).
        // Such ranges are aggregated from the exact, date-filtered per-day docs
        // instead. Presets (this/last month, year) align to rollup boundaries,
        // so their month docs are already exact — keep using those (cheaper).
        const isCustom = range.kind === "custom";

        // 3) Daily docs: for the by-day chart (small ranges) AND as the
        // aggregation source for custom ranges (any size, so dates are honored).
        if (canShowByDay || isCustom) {
          dailyDocs = await fetchDailyDocsForRange(storeId, rangeStart, rangeEnd);
        }

        // 4) Build aggregate. Custom ⇒ from the date-filtered daily docs; every
        // other range ⇒ from the (boundary-aligned) month docs.
        const agg = emptyAggregate();
        const aggMetrics = isCustom ? dailyDocs.map((d) => d.metric) : monthDocs.map((m) => m.metric);
        for (const metric of aggMetrics) foldMetric(agg, metric);

        const avgBasket = agg.txCount > 0 ? agg.netSales / agg.txCount : 0;
        const avgDineInSessionMs = agg.dineInDurationCount > 0 ? agg.dineInDurationMsSum / agg.dineInDurationCount : 0;

        // 5) Sales-over-time + by-month series. For custom ranges these are built
        // from the date-filtered daily docs bucketed by month (partial months
        // included) so the month charts honor the dates too; otherwise straight
        // from the month rollups. (byMonthSorted stays month-doc-based — it feeds
        // the year-over-year comparison, which is month-granular by nature.)
        const byMonthSorted = [...monthDocs].sort((a, b) => a.monthId.localeCompare(b.monthId));
        const netOfMetric = (m: DailyMetric) =>
          (m.payments?.totalGross || 0) - (m.payments?.discountsTotal || 0) - (m.payments?.chargesTotal || 0);
        const monthSeries: Array<{ monthId: string; net: number; tx: number; dineIn: number; walkIn: number }> = (() => {
          if (isCustom) {
            const map = new Map<string, { monthId: string; net: number; tx: number; dineIn: number; walkIn: number }>();
            for (const { dayId, metric } of dailyDocs) {
              const mid = dayId.slice(0, 6);
              const row = map.get(mid) || { monthId: mid, net: 0, tx: 0, dineIn: 0, walkIn: 0 };
              row.net += netOfMetric(metric);
              row.tx += metric.payments?.txCount || 0;
              row.dineIn += metric.sales?.salesAmountByMode?.dineIn || 0;
              row.walkIn += metric.sales?.salesAmountByMode?.walkIn || 0;
              map.set(mid, row);
            }
            return [...map.values()].sort((a, b) => a.monthId.localeCompare(b.monthId));
          }
          return byMonthSorted.map(({ monthId, metric }) => ({
            monthId,
            net: netOfMetric(metric),
            tx: metric.payments?.txCount || 0,
            dineIn: metric.sales?.salesAmountByMode?.dineIn || 0,
            walkIn: metric.sales?.salesAmountByMode?.walkIn || 0,
          }));
        })();

        const salesByMonth = monthSeries.map((r) => ({
          monthId: r.monthId,
          monthLabel: monthIdLabel(r.monthId),
          net: r.net,
          tx: r.tx,
        }));

        const modeSplitByMonth = monthSeries.map((r) => ({
          monthId: r.monthId,
          monthLabel: monthIdLabel(r.monthId),
          dineIn: r.dineIn,
          walkIn: r.walkIn,
        }));

        let byDay: DayRow[] | null = null;
        if (canShowByDay) {
          byDay = dailyDocs
            .map(({ dayId, metric }) => ({
              dayId,
              date: dayIdToDate(dayId),
              net: (metric.payments?.totalGross || 0) - (metric.payments?.discountsTotal || 0) - (metric.payments?.chargesTotal || 0),
              tx: metric.payments?.txCount || 0,
            }))
            .sort((a, b) => a.date.getTime() - b.date.getTime());
        }

        // 6) Best/worst
        const monthRows: MonthRow[] = salesByMonth.map(m => ({ monthId: m.monthId, label: m.monthLabel, net: m.net, tx: m.tx }));
        const monthSorted = [...monthRows].filter(r => r.net > 0).sort((a, b) => b.net - a.net);
        const bestMonths = monthSorted.slice(0, 5);
        const worstMonths = [...monthSorted].reverse().slice(0, 5);

        // For best/worst day: if we have dailyDocs already, use them; else drill into the top-2 best and bottom-2 worst months.
        let dayPool: DayRow[] = byDay ?? [];
        if (dayPool.length === 0) {
          const candidateMonthIds = Array.from(new Set([
            ...bestMonths.slice(0, 2).map(m => m.monthId),
            ...worstMonths.slice(0, 2).map(m => m.monthId),
          ]));
          if (candidateMonthIds.length > 0) {
            const drillDocs = await Promise.all(candidateMonthIds.map(async mid => {
              const y = parseInt(mid.slice(0, 4), 10);
              const m = parseInt(mid.slice(4, 6), 10) - 1;
              const monthStart = new Date(y, m, 1);
              const monthEnd = new Date(y, m + 1, 0);
              return fetchDailyDocsForRange(storeId, monthStart, monthEnd);
            }));
            dayPool = drillDocs.flat()
              .map(({ dayId, metric }) => ({
                dayId,
                date: dayIdToDate(dayId),
                net: (metric.payments?.totalGross || 0) - (metric.payments?.discountsTotal || 0) - (metric.payments?.chargesTotal || 0),
                tx: metric.payments?.txCount || 0,
              }));
          }
        }

        const positiveDays = dayPool.filter(d => d.net > 0);
        const daySortedDesc = [...positiveDays].sort((a, b) => b.net - a.net);
        const bestDays = daySortedDesc.slice(0, 5);
        const worstDays = [...daySortedDesc].reverse().slice(0, 5);

        // 7) Comparative
        const dineInShare = agg.salesByMode.dineIn + agg.salesByMode.walkIn > 0
          ? agg.salesByMode.dineIn / (agg.salesByMode.dineIn + agg.salesByMode.walkIn)
          : 0;
        const current = {
          netSales: agg.netSales,
          tx: agg.txCount,
          dineInShare,
          guests: agg.totalGuests,
        };
        let previous = { netSales: 0, tx: 0, dineInShare: 0, guests: 0 };
        if (range.kind === "custom") {
          // Day-accurate previous period (same number of days immediately before
          // the range) to match the now day-accurate current aggregate.
          const span = diffDays(rangeStart, rangeEnd) + 1;
          const prevEnd = addDays(rangeStart, -1);
          const prevStart = addDays(prevEnd, -(span - 1));
          const prevDailyDocs = await fetchDailyDocsForRange(storeId, prevStart, prevEnd);
          const prevAgg = emptyAggregate();
          for (const { metric } of prevDailyDocs) foldMetric(prevAgg, metric);
          const prevShare = prevAgg.salesByMode.dineIn + prevAgg.salesByMode.walkIn > 0
            ? prevAgg.salesByMode.dineIn / (prevAgg.salesByMode.dineIn + prevAgg.salesByMode.walkIn)
            : 0;
          previous = { netSales: prevAgg.netSales, tx: prevAgg.txCount, dineInShare: prevShare, guests: prevAgg.totalGuests };
        } else if (range.kind === "year") {
          const prevYear = range.year - 1;
          if (availableYears.includes(prevYear)) {
            const py = yearDocs.find(y => y.yearId === String(prevYear))?.metric;
            if (py) {
              const net = (py.payments?.totalGross || 0) - (py.payments?.discountsTotal || 0) - (py.payments?.chargesTotal || 0);
              const sShare = (py.sales?.salesAmountByMode?.dineIn || 0) + (py.sales?.salesAmountByMode?.walkIn || 0) > 0
                ? (py.sales?.salesAmountByMode?.dineIn || 0) / ((py.sales?.salesAmountByMode?.dineIn || 0) + (py.sales?.salesAmountByMode?.walkIn || 0))
                : 0;
              previous = { netSales: net, tx: py.payments?.txCount || 0, dineInShare: sShare, guests: py.guests?.guestCountFinalTotal || 0 };
            }
          }
        } else if (range.kind === "thisMonth" || range.kind === "lastMonth") {
          const now = new Date();
          const offset = range.kind === "thisMonth" ? -1 : -2;
          const prevAnchor = new Date(now.getFullYear(), now.getMonth() + offset, 1);
          const prevMonthId = `${prevAnchor.getFullYear()}${String(prevAnchor.getMonth() + 1).padStart(2, "0")}`;
          const prevDocs = await fetchMonthDocs(storeId, [prevMonthId]);
          const prevAgg = emptyAggregate();
          for (const { metric } of prevDocs) foldMetric(prevAgg, metric);
          const prevShare = prevAgg.salesByMode.dineIn + prevAgg.salesByMode.walkIn > 0
            ? prevAgg.salesByMode.dineIn / (prevAgg.salesByMode.dineIn + prevAgg.salesByMode.walkIn)
            : 0;
          previous = { netSales: prevAgg.netSales, tx: prevAgg.txCount, dineInShare: prevShare, guests: prevAgg.totalGuests };
        }

        // YoY by month: last 12 months vs prior 12 months (or full current year vs prior year if year range)
        const yoyByMonth: Array<{ monthLabel: string; thisYear: number; lastYear: number }> = [];
        {
          const sortedMonths = [...byMonthSorted];
          const monthMap = new Map(sortedMonths.map(m => [m.monthId, m]));
          const today = new Date();
          const anchorYear = range.kind === "year" ? range.year : today.getFullYear();
          for (let i = 0; i < 12; i++) {
            const monthIdx = i;
            const tyId = `${anchorYear}${String(monthIdx + 1).padStart(2, "0")}`;
            const lyId = `${anchorYear - 1}${String(monthIdx + 1).padStart(2, "0")}`;
            const ty = monthMap.get(tyId)?.metric;
            const ly = monthMap.get(lyId)?.metric;
            yoyByMonth.push({
              monthLabel: MONTH_LABELS[monthIdx],
              thisYear: ty ? (ty.payments?.totalGross || 0) - (ty.payments?.discountsTotal || 0) - (ty.payments?.chargesTotal || 0) : 0,
              lastYear: ly ? (ly.payments?.totalGross || 0) - (ly.payments?.discountsTotal || 0) - (ly.payments?.chargesTotal || 0) : 0,
            });
          }
        }
        // If allTime / custom and not in monthDocs map, we need to fetch missing months for YoY.
        // For simplicity: yoyByMonth only uses what's already in monthDocs. If a month wasn't loaded, it shows 0.

        // 8) Best time heatmap (totals across range)
        const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
        const countMatrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
        // The per-day-of-week × per-hour breakdown isn't stored as a 2-d field; we approximate by using
        // (a) salesByHourByMode summed across modes for hour totals (rows distributed by salesByDow share).
        const hourTotals = Array(24).fill(0);
        const hourCounts = Array(24).fill(0);
        for (const mode of ["dineIn", "walkIn"] as const) {
          for (const [h, v] of Object.entries(agg.salesByHourByMode[mode])) {
            const hi = parseInt(h, 10);
            if (!Number.isNaN(hi) && hi >= 0 && hi < 24) hourTotals[hi] += v || 0;
          }
          for (const [h, v] of Object.entries(agg.sessionByHourByMode[mode])) {
            const hi = parseInt(h, 10);
            if (!Number.isNaN(hi) && hi >= 0 && hi < 24) hourCounts[hi] += v || 0;
          }
        }
        const dowShares = (() => {
          const total = Object.values(agg.salesByDow).reduce((s, v) => s + (v || 0), 0);
          const shares = Array(7).fill(0);
          if (total <= 0) return shares;
          for (const [k, v] of Object.entries(agg.salesByDow)) {
            const di = parseInt(k, 10);
            if (!Number.isNaN(di) && di >= 0 && di < 7) shares[di] = (v || 0) / total;
          }
          return shares;
        })();
        for (let d = 0; d < 7; d++) {
          for (let h = 0; h < 24; h++) {
            matrix[d][h] = hourTotals[h] * dowShares[d];
            countMatrix[d][h] = hourCounts[h] * dowShares[d];
          }
        }

        // 9) Top sellers
        const topPackages = Array.from(agg.packages.entries())
          .map(([name, v]) => ({ name, ...v }))
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 20);
        const topAddons = Array.from(agg.addons.entries())
          .map(([name, v]) => ({ name, ...v }))
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 20);
        const topRefills = Array.from(agg.refills.entries())
          .map(([name, qty]) => ({ name, qty }))
          .sort((a, b) => b.qty - a.qty)
          .slice(0, 20);

        const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const salesByDow = Array.from({ length: 7 }, (_, d) => ({
          dow: d,
          label: DOW_LABELS[d],
          net: agg.salesByDow[String(d)] || 0,
          sessions: agg.sessionsByDow[String(d)] || 0,
        }));

        const value: DataAnalysisResult = {
          isLoading: false,
          error: null,
          availableYears,
          totals: {
            netSales: agg.netSales,
            grossSales: agg.grossSales,
            txCount: agg.txCount,
            dineInSessions: agg.sessionsByMode.dineIn,
            walkInSessions: agg.sessionsByMode.walkIn,
            totalGuests: agg.totalGuests,
            avgBasket,
            avgDineInSessionMs,
          },
          modeSplit: {
            byMonth: modeSplitByMonth,
            salesShare: agg.salesByMode,
            sessionShare: agg.sessionsByMode,
          },
          salesOverTime: { byMonth: salesByMonth, byDay },
          comparative: { current, previous, yoyByMonth },
          bestWorst: {
            days: { best: bestDays, worst: worstDays },
            months: { best: bestMonths, worst: worstMonths },
          },
          bestTime: { matrix, countMatrix },
          salesByDow,
          topSellers: { packages: topPackages, addons: topAddons, refills: topRefills },
          refresh,
        };

        cache.set(key, { value, timestamp: Date.now() });
        if (!cancelled) {
          setResult(value);
          setIsLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || String(e));
          setIsLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [storeId, JSON.stringify(range), nonce, refresh]);

  return useMemo(() => {
    if (!result) {
      return {
        isLoading,
        error,
        availableYears: [],
        totals: { netSales: 0, grossSales: 0, txCount: 0, dineInSessions: 0, walkInSessions: 0, totalGuests: 0, avgBasket: 0, avgDineInSessionMs: 0 },
        modeSplit: { byMonth: [], salesShare: { dineIn: 0, walkIn: 0 }, sessionShare: { dineIn: 0, walkIn: 0 } },
        salesOverTime: { byMonth: [], byDay: null },
        comparative: { current: { netSales: 0, tx: 0, dineInShare: 0, guests: 0 }, previous: { netSales: 0, tx: 0, dineInShare: 0, guests: 0 }, yoyByMonth: [] },
        bestWorst: { days: { best: [], worst: [] }, months: { best: [], worst: [] } },
        bestTime: { matrix: Array.from({ length: 7 }, () => Array(24).fill(0)), countMatrix: Array.from({ length: 7 }, () => Array(24).fill(0)) },
        salesByDow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, d) => ({ dow: d, label, net: 0, sessions: 0 })),
        topSellers: { packages: [], addons: [], refills: [] },
        refresh,
      } satisfies DataAnalysisResult;
    }
    return { ...result, isLoading, error, refresh };
  }, [result, isLoading, error, refresh]);
}
