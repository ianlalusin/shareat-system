import { describe, it, expect } from "vitest";
import { getDeviceId, type KVStore } from "@/lib/offline/device";

function memStore(): KVStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("getDeviceId", () => {
  it("generates and persists an id on first call", () => {
    const store = memStore();
    let n = 0;
    expect(getDeviceId(store, () => `uuid-${++n}`)).toBe("uuid-1");
  });

  it("returns the same id on subsequent calls (persisted)", () => {
    const store = memStore();
    let n = 0;
    const first = getDeviceId(store, () => `uuid-${++n}`);
    const second = getDeviceId(store, () => `uuid-${++n}`);
    expect(second).toBe(first);
  });
});
