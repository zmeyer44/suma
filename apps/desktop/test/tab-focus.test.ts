import { describe, expect, it } from "vitest";
import { focusAfterClose } from "../src/main/tab-focus";

/**
 * A split holds exactly two tabs in two panes. Closing either one leaves a
 * single page, and a single page is full width — never a half-width pane
 * beside an empty one, and never a third tab conscripted into the layout.
 */
describe("focusAfterClose", () => {
  it("collapses the split when the split half closes", () => {
    // order/index are post-removal: "b" is gone.
    expect(
      focusAfterClose({
        order: ["a", "c"],
        index: 1,
        closedId: "b",
        activeId: "a",
        splitId: "b",
      }),
    ).toEqual({ activeId: "a", splitId: null });
  });

  it("promotes the other half when the active half closes", () => {
    // "c" sits where "a" was, but the split partner is what the layout is
    // made of — it takes the whole hole rather than yielding it to "c".
    expect(
      focusAfterClose({
        order: ["c", "b"],
        index: 0,
        closedId: "a",
        activeId: "a",
        splitId: "b",
      }),
    ).toEqual({ activeId: "b", splitId: null });
  });

  it("leaves both panes alone when a background tab closes", () => {
    expect(
      focusAfterClose({
        order: ["a", "b"],
        index: 2,
        closedId: "c",
        activeId: "a",
        splitId: "b",
      }),
    ).toEqual({ activeId: "a", splitId: "b" });
  });

  it("falls back to the neighbour when the active tab closes unsplit", () => {
    expect(
      focusAfterClose({
        order: ["a", "c"],
        index: 1,
        closedId: "b",
        activeId: "b",
        splitId: null,
      }),
    ).toEqual({ activeId: "c", splitId: null });
  });

  it("takes the last tab when the trailing active tab closes", () => {
    expect(
      focusAfterClose({
        order: ["a", "b"],
        index: 2,
        closedId: "c",
        activeId: "c",
        splitId: null,
      }),
    ).toEqual({ activeId: "b", splitId: null });
  });

  it("empties both panes with the last tab", () => {
    expect(
      focusAfterClose({
        order: [],
        index: 0,
        closedId: "a",
        activeId: "a",
        splitId: null,
      }),
    ).toEqual({ activeId: null, splitId: null });
  });
});
