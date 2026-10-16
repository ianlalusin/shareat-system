import { describe, it, expect } from "vitest";
import { applyRefillTap, pruneFlavorless, picksFlavorFor } from "../refill-selection";

type Item = { flavorIds: string[]; notes: string };
const make = (): Item => ({ flavorIds: [], notes: "" });

const PORK = "pork";
const BEEF = "beef";
const SEAFOOD = "seafood";          // requires no flavor
const OTHER = "__OTHER_REFILLS__";  // focus-only panel

const needsFlavor = (id: string) => id === PORK || id === BEEF;

function tap(state: { cart: Map<string, Item>; activeId: string | null }, id: string, focusOnly = false) {
  return applyRefillTap<Item>({
    cart: state.cart, activeId: state.activeId, tappedId: id, needsFlavor,
    createItem: focusOnly ? undefined : make,
  });
}

const empty = () => ({ cart: new Map<string, Item>(), activeId: null as string | null });

/** The invariant the old code broke. */
function assertConsistent(s: { cart: Map<string, Item>; activeId: string | null }) {
  if (s.activeId === null || s.activeId === OTHER) return;
  expect(s.cart.has(s.activeId)).toBe(true);
}

describe("the reported bug: picker disappears and never returns", () => {
  it("keeps the picker alive through Pork -> Beef -> deselect -> Beef x3", () => {
    let s = empty();

    s = tap(s, PORK);
    expect(picksFlavorFor(s.cart, s.activeId)).not.toBeNull();
    assertConsistent(s);

    // Jumping to Beef without picking a Pork flavor drops Pork (the stated rule).
    s = tap(s, BEEF);
    expect([...s.cart.keys()]).toEqual([BEEF]);
    expect(s.activeId).toBe(BEEF);
    expect(picksFlavorFor(s.cart, s.activeId)).not.toBeNull();
    assertConsistent(s);

    // Tapping Beef repeatedly used to leave cart and focus permanently
    // anti-correlated, hiding the picker forever.
    for (let i = 0; i < 3; i++) {
      s = tap(s, BEEF);
      assertConsistent(s);
      // Whenever something is selected, the picker must be showing for it.
      if (s.cart.size > 0) expect(picksFlavorFor(s.cart, s.activeId)).not.toBeNull();
    }
  });

  it("never leaves activeId pointing at a removed entry", () => {
    // The precise old failure: focus moved onto the id that was just deleted.
    let s = empty();
    s = tap(s, PORK);
    s.cart.get(PORK)!.flavorIds = ["bulgogi"]; // give Pork a flavor so it survives
    s = tap(s, BEEF);
    expect(s.cart.has(PORK)).toBe(true);
    s = tap(s, BEEF); // deselect the focused one
    expect(s.activeId).toBeNull();
    assertConsistent(s);
  });
});

describe("a flavor-requiring refill only stays selected once it has a flavor", () => {
  it("drops a flavorless meat when focus moves to another meat", () => {
    let s = empty();
    s = tap(s, PORK);
    s = tap(s, BEEF);
    expect(s.cart.has(PORK)).toBe(false);
  });

  it("keeps a meat that already has a flavor", () => {
    let s = empty();
    s = tap(s, PORK);
    s.cart.get(PORK)!.flavorIds = ["bulgogi"];
    s = tap(s, BEEF);
    expect(s.cart.has(PORK)).toBe(true);
    expect(s.cart.get(PORK)!.flavorIds).toEqual(["bulgogi"]);
  });

  it("keeps a refill that does not require a flavor", () => {
    let s = empty();
    s = tap(s, SEAFOOD);
    s = tap(s, BEEF);
    expect(s.cart.has(SEAFOOD)).toBe(true);
  });

  it("drops a flavorless meat when focus moves to the Other Refills panel", () => {
    let s = empty();
    s = tap(s, PORK);
    s = tap(s, OTHER, true);
    expect(s.cart.has(PORK)).toBe(false);
    expect(s.activeId).toBe(OTHER);
  });

  it("exempts the entry being edited", () => {
    let s = empty();
    s = tap(s, PORK);
    expect(s.cart.has(PORK)).toBe(true); // still flavorless, but it is the focused one
  });
});

describe("revisiting a selected refill", () => {
  it("reopens it instead of deselecting, preserving its flavor", () => {
    let s = empty();
    s = tap(s, PORK);
    s.cart.get(PORK)!.flavorIds = ["bulgogi"];
    s = tap(s, BEEF);
    s.cart.get(BEEF)!.flavorIds = ["galbi"];

    s = tap(s, PORK); // selected but not focused
    expect(s.activeId).toBe(PORK);
    expect(s.cart.has(PORK)).toBe(true);
    expect(s.cart.get(PORK)!.flavorIds).toEqual(["bulgogi"]);
    expect(s.cart.has(BEEF)).toBe(true);
  });

  it("deselects on the second tap, once it is focused", () => {
    let s = empty();
    s = tap(s, PORK);
    s.cart.get(PORK)!.flavorIds = ["bulgogi"];
    s = tap(s, BEEF);
    s = tap(s, PORK); // reopen
    s = tap(s, PORK); // now deselect
    expect(s.cart.has(PORK)).toBe(false);
    expect(s.activeId).toBeNull();
  });
});

describe("Other Refills panel", () => {
  it("never becomes a cart entry", () => {
    let s = empty();
    s = tap(s, OTHER, true);
    expect(s.cart.has(OTHER)).toBe(false);
    expect(s.activeId).toBe(OTHER);
  });

  it("toggles focus off when tapped again", () => {
    let s = empty();
    s = tap(s, OTHER, true);
    s = tap(s, OTHER, true);
    expect(s.activeId).toBeNull();
  });
});

describe("pruneFlavorless", () => {
  it("leaves a flavored entry and the focused entry alone", () => {
    const cart = new Map<string, Item>([
      [PORK, { flavorIds: ["bulgogi"], notes: "" }],
      [BEEF, { flavorIds: [], notes: "" }],
      [SEAFOOD, { flavorIds: [], notes: "" }],
    ]);
    const out = pruneFlavorless(cart, BEEF, needsFlavor);
    expect([...out.keys()].sort()).toEqual([BEEF, PORK, SEAFOOD].sort());
  });

  it("removes a flavorless meat that is not focused", () => {
    const cart = new Map<string, Item>([[BEEF, { flavorIds: [], notes: "" }]]);
    expect(pruneFlavorless(cart, null, needsFlavor).size).toBe(0);
  });
});
