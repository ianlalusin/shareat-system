/** T-532 S1 — the test slip: store name, time, three columns at the chosen width. Pure. */
import { columnsFor, center, rule } from './layout';
import type { FontMode, PaperWidth } from './types';

export function testSlipLines(storeName: string, timeLocal: string, width: PaperWidth, font: FontMode): string[] {
  const cols = columnsFor({ width, font });
  const third = Math.floor(cols / 3);
  const cell = (s: string) => s.padEnd(third).slice(0, third);
  return [
    center(storeName || 'SharEat POS', cols),
    center('PRINTER TEST', cols),
    center(timeLocal, cols),
    rule(cols),
    cell('LEFT') + center('MIDDLE', cols - 2 * third) + 'RIGHT'.padStart(third),
    rule(cols),
    center(`${width} mm - ${cols} columns - P1,234.50`, cols),
    '',
  ];
}
