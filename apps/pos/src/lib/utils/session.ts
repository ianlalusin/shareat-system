

export function computeSessionLabel({
  sessionMode,
  customerName,
  tableNumber,
  tableDisplayName,
}: {
  sessionMode?: 'package_dinein' | 'alacarte' | null;
  customerName?: string | null;
  tableNumber?: string | number | null;
  tableDisplayName?: string | null;
}): string {
  if (sessionMode === 'alacarte') {
    return (customerName || 'Ala Carte').trim();
  }
  if (tableDisplayName && tableDisplayName.trim()) return tableDisplayName.trim();
  const num = (tableNumber ?? '').toString().trim();
  if (num) return `Table ${num}`;
  if (customerName && customerName.trim()) return customerName.trim();
  return 'Session';
}
