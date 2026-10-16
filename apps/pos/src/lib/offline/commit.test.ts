import { describe, it, expect, vi } from "vitest";
import { commitLocalFirst, type Committable } from "@/lib/offline/commit";

describe("commitLocalFirst", () => {
  it("returns undefined synchronously even when the commit never resolves (offline)", () => {
    const batch: Committable = { commit: () => new Promise<void>(() => {}) };
    let result: unknown = "sentinel";
    expect(() => {
      result = commitLocalFirst(batch);
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it("invokes the batch commit exactly once", () => {
    const commit = vi.fn(() => Promise.resolve());
    commitLocalFirst({ commit });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("routes a server-side commit failure to onError", async () => {
    const err = new Error("permission denied");
    const onError = vi.fn();
    commitLocalFirst({ commit: () => Promise.reject(err) }, onError);
    // let the rejection microtask settle
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("swallows a commit failure when no onError is given (no synchronous throw)", () => {
    const commit = vi.fn(() => Promise.reject(new Error("x")));
    expect(() => commitLocalFirst({ commit })).not.toThrow();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("still invokes a throwing onError once and does not escape as an unhandled rejection", async () => {
    const onError = vi.fn(() => {
      throw new Error("boom");
    });
    commitLocalFirst({ commit: () => Promise.reject(new Error("x")) }, onError);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
