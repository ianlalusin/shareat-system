/**
 * T-527b - device-made ids that sort in creation order. A UUIDv7 puts the millisecond first, then a 12-bit counter, so ids made in the SAME millisecond
 * still sort in the order they were made (a plain v4 would sort them at random). The table's list is ordered by (addedAtDevice, lineId) on the tablet and
 * on the server; every line of one event shares one addedAtDevice, so the id carries the cashier's cart order. Pure apart from the clock and the random source.
 */
export function makeIdGenerator(clock: () => number = Date.now, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): () => string {
  let lastMs = 0;
  let counter = 0;
  const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return () => {
    let ms = Math.max(clock(), lastMs);
    if (ms === lastMs) {
      counter += 1;
      if (counter > 0xfff) {
        ms += 1; // 4096 ids in one millisecond: borrow the next one rather than repeat or go backwards
        counter = 0;
      }
    } else counter = 0;
    lastMs = ms;
    const t = ms.toString(16).padStart(12, '0');
    const r = random(8);
    const variant = (8 + (r[0]! & 3)).toString(16); // RFC 4122 variant 10xx
    return `${t.slice(0, 8)}-${t.slice(8)}-7${counter.toString(16).padStart(3, '0')}-${variant}${hex(r.slice(1, 3)).slice(1)}-${hex(r.slice(3, 8)).padStart(10, '0')}${hex(random(1))}`;
  };
}

/** The one generator the Orders screen uses for session and line ids. */
export const newDeviceId: () => string = makeIdGenerator();
