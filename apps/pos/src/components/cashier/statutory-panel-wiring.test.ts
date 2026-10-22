import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const source = readFileSync(new URL('./StatutoryDinersPanel.tsx', import.meta.url), 'utf8');
it('mounts the capture panel on the bill and sends changes through the transactional writer', () => {
  const page = readFileSync(new URL('./session-detail-view.tsx', import.meta.url), 'utf8');
  expect(page.includes('<StatutoryDinersPanel ')).toBe(true);
  expect(source.includes('await mutateStatutoryDiners(')).toBe(true);
  expect(source.includes('pruneDishAssignments(diners, lines)')).toBe(true);
  expect(source.includes('maskIdNo(row.diner.idNo)')).toBe(true);
});
it('keeps tables on tablet and desktop, phone cards, unique input ids and a phone bottom action', () => {
  for (const target of ['lg:grid-cols-3', 'hidden overflow-x-auto md:block', 'divide-y md:hidden', 'sticky bottom-0', 'min-h-11', 'useId()']) {
    expect(source.includes(target), target).toBe(true);
  }
});
it('keeps the entire payable amount readable instead of ellipsizing it', () => {
  expect(source).not.toContain('truncate text-2xl');
  expect(source).toContain('break-words text-2xl');
});
