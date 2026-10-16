import { describe, it, expect } from "vitest";
import { getBrowserDeviceId, deviceReceiptTag } from "@/lib/offline/browserDevice";
import type { KVStore } from "@/lib/offline/device";

function memStore(): KVStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("getBrowserDeviceId", () => {
  it("returns a stable, non-empty id backed by the provided store", () => {
    const store = memStore();
    const a = getBrowserDeviceId(store);
    const b = getBrowserDeviceId(store);
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(b).toBe(a); // persisted, so stable across calls
  });
});

describe("deviceReceiptTag", () => {
  it("returns the first 4 alphanumeric chars, uppercased", () => {
    expect(deviceReceiptTag("ab12cd34-ef56")).toBe("AB12");
  });
  it("strips non-alphanumerics before taking 4 chars", () => {
    expect(deviceReceiptTag("--a1-b2-c3--")).toBe("A1B2");
  });
  it("falls back to 0000 for a degenerate id", () => {
    expect(deviceReceiptTag("----")).toBe("0000");
  });
});
