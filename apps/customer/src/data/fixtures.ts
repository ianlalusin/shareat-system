import { money } from '@shareat/core/money';
import type { MenuItem, Store } from './types';

/** Made-up sample data. Nothing here is a real PIN, price or store record. */

export const DEMO_STORES: Store[] = [
  { id: 'store-lipa', name: 'Shareat Lipa (demo)', googleReviewUrl: 'https://g.page/r/demo' },
  { id: 'store-malvar', name: 'Shareat Malvar (demo)', googleReviewUrl: null },
];

export interface DemoTable {
  label: string;
  pin: string;
  qrToken: string;
  storeId: string;
}

export const DEMO_TABLES: DemoTable[] = [
  { label: 'Table 1', pin: '482915', qrToken: 'demo-qr-lipa-1', storeId: 'store-lipa' },
  { label: 'Table 2', pin: '736204', qrToken: 'demo-qr-lipa-2', storeId: 'store-lipa' },
  { label: 'Table 1', pin: '159863', qrToken: 'demo-qr-malvar-1', storeId: 'store-malvar' },
];

export const DEMO_MENU: MenuItem[] = [
  { id: 'm-pork', name: 'Extra pork belly', category: 'Add-on meats', kind: 'addon', price: money('89.50') },
  { id: 'm-beef', name: 'Extra beef slices', category: 'Add-on meats', kind: 'addon', price: money('129.00') },
  { id: 'm-chicken', name: 'Extra chicken', category: 'Add-on meats', kind: 'addon', price: money('79.75') },
  { id: 'm-kimchi', name: 'Kimchi', category: 'Sides', kind: 'addon', price: money('45.00') },
  { id: 'm-rice', name: 'Steamed rice', category: 'Sides', kind: 'addon', price: money('25.00') },
  { id: 'm-corn', name: 'Cheese corn', category: 'Sides', kind: 'addon', price: money('65.00') },
  { id: 'm-tea', name: 'Iced tea', category: 'Drinks', kind: 'addon', price: money('55.00') },
  { id: 'm-soda', name: 'Soda', category: 'Drinks', kind: 'addon', price: money('49.00') },
  { id: 'm-water', name: 'Bottled water', category: 'Drinks', kind: 'addon', price: money('30.00') },
  { id: 'r-rice', name: 'Rice refill', category: 'Refills', kind: 'refill', price: money('0.00') },
  { id: 'r-side', name: 'Side dish refill', category: 'Refills', kind: 'refill', price: money('0.00') },
  { id: 'r-tea', name: 'Iced tea refill', category: 'Refills', kind: 'refill', price: money('0.00') },
];
