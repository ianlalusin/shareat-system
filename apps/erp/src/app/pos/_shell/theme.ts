/**
 * T-526 R1 (bible row 433) - the Kitchen screen is dark unless the viewer chose light; every other route keeps the ERP's rule
 * (anything that is not exactly 'dark' is light). `theme-state.ts` is not changed.
 */
import { parseTheme, type Theme } from '@/components/shell/theme-state';

const KITCHEN = '/pos/kitchen';

export function posThemeFor(pathname: string, rawCookie: string | undefined | null): Theme {
  const kitchen = pathname === KITCHEN || pathname.startsWith(`${KITCHEN}/`);
  return kitchen ? (rawCookie === 'light' ? 'light' : 'dark') : parseTheme(rawCookie);
}
