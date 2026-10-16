import { describe, it, expect, vi } from "vitest";
import { replayDeferredEffects } from "@/lib/offline/replayDeferredEffects";
import type { QueuedPayment } from "@/lib/offline/payment-queue";

function item(effects: Partial<QueuedPayment["effects"]> = {}): QueuedPayment {
  return {
    id: "q1", storeId: "s1", sessionId: "sess1", receiptId: "sess1", queuedAtMs: 0, status: "pending",
    ctx: { pin: "1234", phone: "0917", amount: 100 },
    effects: { analytics: "pending", loyaltyFinalize: "pending", loyaltyEarn: "pending", pinFinalize: "pending", loyaltyReverse: "skip", ...effects },
  };
}
const ok = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
const fail = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);

describe("replayDeferredEffects", () => {
  it("marks all effects done and reports complete when every call succeeds", async () => {
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    const { item: out, complete } = await replayDeferredEffects(item(), { getToken: async () => "tok", fetchImpl });
    expect(complete).toBe(true);
    expect(out.effects).toEqual({ analytics: "done", loyaltyFinalize: "done", loyaltyEarn: "done", pinFinalize: "done", loyaltyReverse: "skip" });
    // one call per pending effect (loyaltyReverse is skip for payment items)
    expect((fetchImpl as any).mock.calls.length).toBe(4);
  });

  it("leaves a failed effect pending and reports not complete", async () => {
    // analytics ok, loyaltyFinalize fails, others ok
    const fetchImpl = vi.fn((url: string) =>
      String(url).includes("/loyalty/finalize") ? fail() : ok(),
    ) as unknown as typeof fetch;
    const { item: out, complete } = await replayDeferredEffects(item(), { getToken: async () => "tok", fetchImpl });
    expect(complete).toBe(false);
    expect(out.effects.loyaltyFinalize).toBe("pending");
    expect(out.effects.analytics).toBe("done");
  });

  it("does not call endpoints for effects already done/skip", async () => {
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    const out = await replayDeferredEffects(
      item({ analytics: "done", loyaltyEarn: "skip", loyaltyFinalize: "done", pinFinalize: "pending" }),
      { getToken: async () => "tok", fetchImpl },
    );
    expect((fetchImpl as any).mock.calls.length).toBe(1); // only pinFinalize
    expect(out.complete).toBe(true);
  });

  it("includes the bearer token and correct body for loyalty earn", async () => {
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    await replayDeferredEffects(item({ analytics: "skip", loyaltyFinalize: "skip", pinFinalize: "skip" }), { getToken: async () => "tok", fetchImpl });
    const call = (fetchImpl as any).mock.calls.find((c: any[]) => String(c[0]).includes("/loyalty/earn"));
    expect(call).toBeTruthy();
    expect(call[1].headers.Authorization).toBe("Bearer tok");
    const body = JSON.parse(call[1].body);
    expect(body).toMatchObject({ storeId: "s1", sessionId: "sess1", phone: "0917", amount: 100, receiptId: "sess1" });
  });

  it("calls onEffectDone after each successful effect (incremental persistence)", async () => {
    const doneCounts: number[] = [];
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    await replayDeferredEffects(item(), {
      getToken: async () => "tok",
      fetchImpl,
      onEffectDone: (it) => doneCounts.push(Object.values(it.effects).filter((v) => v === "done").length),
    });
    expect(doneCounts).toEqual([1, 2, 3, 4]); // one more effect done each call
  });

  it("returns not-complete and does not fetch when getToken throws (transient)", async () => {
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    const { complete } = await replayDeferredEffects(item(), {
      getToken: async () => { throw new Error("no token"); },
      fetchImpl,
    });
    expect(complete).toBe(false);
    expect((fetchImpl as any).mock.calls.length).toBe(0);
  });
});

describe("replay void effects", () => {
  function voidItem() {
    return {
      id: "v1", storeId: "s1", sessionId: "sess1", receiptId: "sess1", queuedAtMs: 0, status: "pending" as const, kind: "void" as const,
      ctx: { amount: 0, pin: "1234", redemptionIds: ["r1", "r2"] },
      effects: { analytics: "skip" as const, loyaltyFinalize: "skip" as const, loyaltyEarn: "skip" as const, pinFinalize: "pending" as const, loyaltyReverse: "pending" as const },
    };
  }
  const ok = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);

  it("reverses each redemption (DELETE /api/loyalty/redeem) and finalizes the pin with session_voided", async () => {
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    const { item, complete } = await replayDeferredEffects(voidItem(), { getToken: async () => "tok", fetchImpl });
    expect(complete).toBe(true);
    const calls = (fetchImpl as any).mock.calls;
    const redeemCalls = calls.filter((c: any[]) => String(c[0]).includes("/loyalty/redeem"));
    expect(redeemCalls.length).toBe(2); // one DELETE per redemptionId
    expect(redeemCalls[0][1].method).toBe("DELETE");
    const pinCall = calls.find((c: any[]) => String(c[0]).includes("/pins/finalize"));
    expect(JSON.parse(pinCall[1].body)).toMatchObject({ storeId: "s1", sessionId: "sess1", pin: "1234", reason: "session_voided" });
    expect(item.effects.loyaltyReverse).toBe("done");
    expect(item.effects.pinFinalize).toBe("done");
  });

  it("leaves loyaltyReverse pending if any redemption DELETE fails", async () => {
    const fetchImpl = vi.fn((url: string) => String(url).includes("/loyalty/redeem")
      ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response) : ok()) as unknown as typeof fetch;
    const { item, complete } = await replayDeferredEffects(voidItem(), { getToken: async () => "tok", fetchImpl });
    expect(complete).toBe(false);
    expect(item.effects.loyaltyReverse).toBe("pending");
  });

  it("leaves loyaltyReverse pending when the FIRST delete fails even though a later one would succeed (guards against last-write-wins)", async () => {
    let redeemN = 0;
    const fetchImpl = vi.fn((url: string) => {
      if (String(url).includes("/loyalty/redeem")) {
        redeemN += 1;
        // first redemption fails; a later one would succeed — a last-iteration-wins
        // bug would mark the effect done, but all-must-succeed must keep it pending.
        return Promise.resolve({ ok: redeemN > 1, status: redeemN > 1 ? 200 : 500, json: async () => ({}) } as Response);
      }
      return ok();
    }) as unknown as typeof fetch;
    const { item, complete } = await replayDeferredEffects(voidItem(), { getToken: async () => "tok", fetchImpl });
    expect(item.effects.loyaltyReverse).toBe("pending");
    expect(complete).toBe(false);
  });

  it("marks loyaltyReverse done with zero redeem calls when there are no redemptionIds", async () => {
    const item0 = voidItem();
    item0.ctx.redemptionIds = [];
    const fetchImpl = vi.fn(ok) as unknown as typeof fetch;
    const { item, complete } = await replayDeferredEffects(item0, { getToken: async () => "tok", fetchImpl });
    const redeemCalls = (fetchImpl as any).mock.calls.filter((c: any[]) => String(c[0]).includes("/loyalty/redeem"));
    expect(redeemCalls.length).toBe(0);
    expect(item.effects.loyaltyReverse).toBe("done");
    expect(complete).toBe(true);
  });
});
