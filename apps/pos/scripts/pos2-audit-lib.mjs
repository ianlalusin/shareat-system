/** Pure T-427 classifications. The caller supplies final day totals; advisory write-time flags never decide a finding. */
const manilaDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });
export const auditDayOf = (ms) => manilaDay.format(new Date(ms)).replace(/-/g, '');
export function auditRange(from, to) {
  const start = (value) => {
    if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return null;
    const ms = Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00+08:00`);
    return Number.isFinite(ms) && auditDayOf(ms) === value ? ms : null;
  };
  const fromMs = start(from), toStartMs = start(to);
  return fromMs === null || toStartMs === null || fromMs > toStartMs ? null : { fromMs, toMs: toStartMs + 86_400_000 - 1 };
}

export function classifyConversion(conversion) {
  if (conversion.source === 'pos2-correction') return conversion.status === 'voided' ? ['voidedCorrection'] : [];
  if (conversion.source === 'pos2-convert') return conversion.status === 'voided' && conversion.voidedVia !== 'pos2' ? ['voidedByV1'] : [];
  return ['foreign'];
}

export function negativeDays(days, conversions) {
  return days.map((day) => ({
    dayId: day.dayId,
    methods: Object.entries(day.byMethod ?? {}).filter(([, total]) => typeof total === 'number' && Number.isFinite(total) && total < 0)
      .map(([name, total]) => ({ name, total })).sort((a, b) => a.name.localeCompare(b.name)),
    conversionIds: conversions.filter((conversion) => conversion.dayId === day.dayId).map((conversion) => conversion.id).sort(),
  })).filter((day) => day.methods.length > 0).sort((a, b) => a.dayId.localeCompare(b.dayId));
}

/** T-471: the Z numbers ('Z-0001' style) missing between Z-0001 and the highest one present. The sequence never resets, so a hole means a Z was lost. At most 10000 are listed. */
export function zGaps(zNos) {
  const seen = new Set();
  for (const no of zNos) {
    const m = /^Z-(\d+)$/.exec(String(no));
    const n = m ? Number(m[1]) : 0;
    if (Number.isSafeInteger(n) && n > 0) seen.add(n);
  }
  const max = seen.size ? Math.max(...seen) : 0;
  const gaps = [];
  for (let n = 1; n < max && gaps.length < 10000; n++) if (!seen.has(n)) gaps.push(`Z-${String(n).padStart(4, '0')}`);
  return gaps;
}
