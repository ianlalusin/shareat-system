import { Sun, Cloudy, CloudRain, CloudLightning, Moon } from "lucide-react";
import type { WeatherCondition } from "@/lib/types";

export type WeatherIconMeta = {
  label: string;
  icon: React.ElementType;
  gradient: string;
  iconColor: string;
};

const DAY_ICONS: Record<WeatherCondition, WeatherIconMeta> = {
  sunny: { label: "Sunny", icon: Sun, gradient: "from-amber-400 to-orange-500", iconColor: "text-white" },
  cloudy: { label: "Cloudy", icon: Cloudy, gradient: "from-slate-300 to-slate-500", iconColor: "text-white" },
  light_rain: { label: "Light Rain", icon: CloudRain, gradient: "from-sky-400 to-blue-600", iconColor: "text-white" },
  heavy_rain: { label: "Heavy Rain", icon: CloudLightning, gradient: "from-indigo-500 to-purple-700", iconColor: "text-white" },
};

const NIGHT_SUNNY_OVERRIDE: WeatherIconMeta = {
  label: "Clear",
  icon: Moon,
  gradient: "from-indigo-900 to-slate-800",
  iconColor: "text-amber-300",
};

// Calendar-only variant — white background with a colored glyph + thin
// border so small icons stay legible at calendar-cell scale where the
// dark gradients lose contrast. Logger modal + floating button keep the
// colorful gradient look.
const CALENDAR_GLYPH_COLOR: Record<WeatherCondition, string> = {
  sunny: "text-amber-500",
  cloudy: "text-slate-500",
  light_rain: "text-sky-500",
  heavy_rain: "text-indigo-600",
};
const CALENDAR_NIGHT_CLEAR_COLOR = "text-indigo-500";
const CALENDAR_WHITE_BG = "from-white to-white border border-border";

export function isNightHour(hour: number): boolean {
  return hour >= 18 || hour < 6;
}

/** Resolve a condition to its display meta, optionally swapping sunny→clear at night. */
export function getWeatherIcon(condition: WeatherCondition, atNight = false): WeatherIconMeta {
  if (atNight && condition === "sunny") return NIGHT_SUNNY_OVERRIDE;
  return DAY_ICONS[condition];
}

/** All condition tiles, with the night override applied to sunny when needed. */
export function getWeatherOptions(atNight = false): Array<WeatherIconMeta & { value: WeatherCondition }> {
  return (Object.keys(DAY_ICONS) as WeatherCondition[]).map((value) => ({
    value,
    ...getWeatherIcon(value, atNight),
  }));
}

/** Calendar-cell variant: solid white bg + colored glyph for legibility at small sizes. */
export function getCalendarWeatherIcon(condition: WeatherCondition, atNight = false): WeatherIconMeta {
  const base = getWeatherIcon(condition, atNight);
  const isNightClear = atNight && condition === "sunny";
  return {
    ...base,
    gradient: CALENDAR_WHITE_BG,
    iconColor: isNightClear ? CALENDAR_NIGHT_CLEAR_COLOR : CALENDAR_GLYPH_COLOR[condition],
  };
}
