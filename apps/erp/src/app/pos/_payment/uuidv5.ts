/**
 * T-528 - RFC 4122 name-based (SHA-1) uuid on the device, with WebCrypto. The twin of `uuidv5(name, namespace)` in packages/domain/src/pos/shared.ts (that file
 * imports the database, so the tablet cannot use it): same bytes in, same id out, which the unit test proves against the RFC vector and the server's own function.
 */
const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function uuidv5(name: string, namespace: string): Promise<string> {
  const hexNs = namespace.replace(/-/g, '');
  const ns = Uint8Array.from(hexNs.match(/../g) ?? [], (h) => parseInt(h, 16));
  const nameBytes = new TextEncoder().encode(name);
  const data = new Uint8Array(ns.length + nameBytes.length);
  data.set(ns, 0);
  data.set(nameBytes, ns.length);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', data)).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = hex(h);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The id the server gives a bundle's extra-heads line (T-524 ruling 3, `order.ts`): uuidv5('extra-heads', the bundle line's id). */
export const extraHeadsId = (bundleLineId: string): Promise<string> => uuidv5('extra-heads', bundleLineId);
