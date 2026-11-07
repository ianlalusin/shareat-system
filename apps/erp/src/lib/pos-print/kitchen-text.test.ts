import { describe, expect, it } from 'vitest';
import { columnsFor } from './layout';
import { formatKitchenTicket, formatRefillSlip } from './kitchen-text';
import type { KitchenTicketView, RefillSlipView } from './types';

/**
 * T-528a — the kitchen ticket and the refill slip.
 *
 * These carry no money at all: a cook needs the station, the table, what to make and any note, and
 * the refill slip needs the same minus the station. The assertions are exact arrays because the
 * printer prints exactly these lines, in this order.
 */

const KITCHEN: string[] = [
  '             GRILL',
  '            OFFLINE',
  'TABLE:                   Stand 7',
  'TICKET:                 K-000118',
  'TIME:             06/11/26 19:41',
  '--------------------------------',
  '4 x Unli Samgyup + Cheese',
  '  * No beef for diner 1',
  '1 x Kimchi fried rice',
];

const KITCHEN_TAKE_OUT: string[] = [
  '             GRILL',
  'TAKE-OUT',
  'TICKET:                 K-000119',
  'TIME:             06/11/26 19:55',
  '--------------------------------',
  '2 x Cheese corn',
];

const REFILL: string[] = [
  '             REFILL',
  'TABLE:                   Stand 7',
  'TIME:             06/11/26 20:02',
  '--------------------------------',
  '1 x Iced tea pitcher',
  '4 x Coke',
];

function ticket(overrides: Partial<KitchenTicketView> = {}): KitchenTicketView {
  return {
    stationName: 'Grill',
    tableLabel: 'Stand 7',
    ticketNo: 'K-000118',
    sentAtLocal: '06/11/26 19:41',
    items: [
      { name: 'Unli Samgyup + Cheese', qty: 4, note: 'No beef for diner 1' },
      { name: 'Kimchi fried rice', qty: 1, note: null },
    ],
    offline: true,
    ...overrides,
  };
}

describe('T-528a — the kitchen ticket and the refill slip', () => {
  it('ticket with notes, take-out, offline', () => {
    expect(formatKitchenTicket(ticket(), { width: 58, font: 'normal' })).toEqual(KITCHEN);
    expect(
      formatKitchenTicket(
        ticket({ tableLabel: null, ticketNo: 'K-000119', sentAtLocal: '06/11/26 19:55', items: [{ name: 'Cheese corn', qty: 2, note: null }], offline: false }),
        { width: 58, font: 'normal' },
      ),
    ).toEqual(KITCHEN_TAKE_OUT);
  });

  it('refill slip', () => {
    const slip: RefillSlipView = {
      tableLabel: 'Stand 7',
      sentAtLocal: '06/11/26 20:02',
      items: [
        { name: 'Iced tea pitcher', qty: 1 },
        { name: 'Coke', qty: 4 },
      ],
      offline: false,
    };
    expect(formatRefillSlip(slip, { width: 58, font: 'normal' })).toEqual(REFILL);
  });

  it('every line fits, and carries no money', () => {
    for (const width of [58, 80] as const) {
      for (const font of ['normal', 'small'] as const) {
        const cols = columnsFor({ width, font });
        for (const line of formatKitchenTicket(ticket(), { width, font })) {
          expect(line.length, `"${line}" in ${width}mm/${font}`).toBeLessThanOrEqual(cols);
        }
      }
    }

    // A prep sheet has no prices on it: nothing in the output can look like an amount.
    const printed = formatKitchenTicket(ticket(), { width: 58, font: 'normal' }).join('\n');
    expect(printed).not.toMatch(/\d+\.\d{2}/);
  });
});
