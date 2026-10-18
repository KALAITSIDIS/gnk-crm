import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ANY, FilterUrlWriter, type TypedValues } from "@/components/features/deals/filter-url-writer";

/**
 * The /deals filter bar's URL bookkeeping (F05 review). The bar writes the
 * search and the closed dates after a 400 ms pause, and a write takes a
 * server render to come back. Before this, the render of an EARLIER write
 * reset the box while the user was still typing — "Mar" landing over
 * "Maria" — and the next keystroke wrote "Mars": "ia" never reached the
 * filter. And a select picked while the search was on its way was built on
 * the URL last rendered, so it superseded the search and dropped it.
 */
const urlOf = (v: Partial<TypedValues> = {}): TypedValues => ({ q: "", closed_from: "", closed_to: "", ...v });
const boxes = urlOf;

describe("a write of ours that lands never moves a box", () => {
  it("the reviewer's sequence: Mar written, ia typed during its render, s typed after — the filter is Marias", () => {
    const w = new FilterUrlWriter("");
    w.queue({ q: "Mar" });
    expect(w.write()).toBe("q=Mar");
    w.queue({ q: "Maria" }); // typed while q=Mar renders
    expect(w.observe("q=Mar", urlOf({ q: "Mar" }), boxes({ q: "Maria" })), "the box keeps Maria").toEqual({});
    w.queue({ q: "Marias" }); // the next keystroke, on the text the box still shows
    expect(w.write()).toBe("q=Marias");
    expect(w.observe("q=Marias", urlOf({ q: "Marias" }), boxes({ q: "Marias" }))).toEqual({});
  });

  it("two writes on their way: the earlier one landing moves nothing, the later one is still expected", () => {
    const w = new FilterUrlWriter("");
    w.queue({ q: "Mar" });
    expect(w.write()).toBe("q=Mar");
    w.queue({ q: "Maria" });
    expect(w.write(), "built on the write still on its way").toBe("q=Maria");
    expect(w.observe("q=Mar", urlOf({ q: "Mar" }), boxes({ q: "Maria" }))).toEqual({});
    // a status picked now is built on q=Maria, not on the q=Mar on screen
    expect(w.write({ status: "lost" })).toBe("q=Maria&status=lost");
    expect(w.observe("q=Maria&status=lost", urlOf({ q: "Maria" }), boxes({ q: "Maria" }))).toEqual({});
  });

  it("the search is written trimmed: a box showing \"Maria \" is not moved to \"Maria\"", () => {
    const w = new FilterUrlWriter("");
    w.queue({ q: "Maria" }); // the bar queues the trimmed text
    expect(w.write()).toBe("q=Maria");
    expect(w.observe("q=Maria", urlOf({ q: "Maria" }), boxes({ q: "Maria " }))).toEqual({});
  });

  it("a date being retyped is not overwritten by the render of the date written before", () => {
    const w = new FilterUrlWriter("");
    w.queue({ closed_from: "2024-03-01" });
    expect(w.write()).toBe("closed_from=2024-03-01");
    // Chrome's segmented input mid-way through a new year: no whole day, so nothing queued
    expect(
      w.observe("closed_from=2024-03-01", urlOf({ closed_from: "2024-03-01" }), boxes({ closed_from: "0002-03-01" })),
    ).toEqual({});
  });

  it("a write from another filter landing leaves a half-typed search alone", () => {
    const w = new FilterUrlWriter("q=Mar");
    w.queue({ q: "Maria" });
    expect(w.write({ type: "rental" }), "the select carries the queued search").toBe("q=Maria&type=rental");
    expect(w.observe("q=Maria&type=rental", urlOf({ q: "Maria" }), boxes({ q: "Maria K" }))).toEqual({});
  });
});

describe("a write is built on the latest URL this bar wrote", () => {
  it("a select picked while the search is on its way keeps the search (it was dropped before)", () => {
    const w = new FilterUrlWriter("type=sale");
    w.queue({ q: "Maria" });
    expect(w.write()).toBe("type=sale&q=Maria");
    // not rendered yet: the status write supersedes it and must carry it
    expect(w.write({ status: "won" })).toBe("type=sale&q=Maria&status=won");
  });

  it("a timer that fires after a render uses that render's URL, not the one it was armed in", () => {
    const w = new FilterUrlWriter("");
    expect(w.write({ status: "won" })).toBe("status=won");
    w.queue({ q: "x" }); // armed before status=won rendered
    expect(w.observe("status=won", urlOf(), boxes({ q: "x" }))).toEqual({});
    expect(w.write()).toBe("status=won&q=x");
  });

  it("every write returns to page 1; undefined, empty and Any remove a parameter", () => {
    const w = new FilterUrlWriter("status=won&type=sale&agent=a&page=3");
    expect(w.write({ status: undefined, type: ANY, agent: "", contact: "c" })).toBe("contact=c");
  });

  it("nothing to navigate to when the write is the URL on screen and nothing is on its way", () => {
    const w = new FilterUrlWriter("status=won");
    expect(w.write({ status: "won" })).toBeNull();
    w.queue({ q: undefined }); // typed and deleted again within the pause
    expect(w.write()).toBeNull();
  });

  it("a change undone while its write is on its way is still written, to supersede it", () => {
    const w = new FilterUrlWriter("");
    w.queue({ q: "Mar" });
    expect(w.write()).toBe("q=Mar");
    w.queue({ q: undefined });
    expect(w.write(), "back to the bare URL, not null").toBe("");
  });

  it("Clear forgets what was queued and writes the bare URL", () => {
    const w = new FilterUrlWriter("q=x&status=won");
    w.queue({ q: "xy" });
    expect(w.clear()).toBe("");
    expect(w.observe("", urlOf(), boxes())).toEqual({});
    expect(w.write(), "the queued search is gone with the rest").toBeNull();
  });
});

describe("the boxes follow a navigation that is not ours", () => {
  it("Back/Forward: every box takes the URL's value", () => {
    const w = new FilterUrlWriter("q=New&closed_from=2024-03-01");
    expect(
      w.observe("q=Old", urlOf({ q: "Old" }), boxes({ q: "New", closed_from: "2024-03-01", closed_to: "0002-01-01" })),
    ).toEqual({ q: "Old", closed_from: "", closed_to: "" });
  });

  it("a box already showing the URL's value is left as it is", () => {
    const w = new FilterUrlWriter("q=Maria");
    expect(w.observe("q=Maria&page=2", urlOf({ q: "Maria" }), boxes({ q: "Maria " }))).toEqual({});
  });

  it("a change waiting for the pause is not moved: it is written on top of the new URL", () => {
    const w = new FilterUrlWriter("");
    w.queue({ q: "Typed" });
    expect(w.observe("status=won", urlOf(), boxes({ q: "Typed", closed_to: "2024-01-31" }))).toEqual({ closed_to: "" });
    expect(w.write()).toBe("status=won&q=Typed");
  });

  it("it supersedes what we had on its way: the box shows the list's filter, and the next write builds on it", () => {
    const w = new FilterUrlWriter("");
    w.queue({ q: "Maria" });
    expect(w.write()).toBe("q=Maria");
    // a pager link built from the URL on screen lands instead
    expect(w.observe("page=2", urlOf(), boxes({ q: "Maria" })), "never a box claiming a filter the list lacks").toEqual({
      q: "",
    });
    expect(w.write({ status: "open" })).toBe("status=open");
  });

  it("the same URL observed twice (an effect run again) changes nothing", () => {
    const w = new FilterUrlWriter("");
    expect(w.observe("q=Old", urlOf({ q: "Old" }), boxes({ q: "New" }))).toEqual({ q: "Old" });
    expect(w.observe("q=Old", urlOf({ q: "Old" }), boxes({ q: "Other" }))).toEqual({});
  });

  it("the first render is the URL the bar was built on: nothing moves", () => {
    const w = new FilterUrlWriter("q=Maria");
    expect(w.observe("q=Maria", urlOf({ q: "Maria" }), boxes({ q: "Maria" }))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The bar itself: uncontrolled boxes still open on the URL's filters
// ---------------------------------------------------------------------------
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  usePathname: () => "/deals",
  useSearchParams: () => new URLSearchParams("q=Maria&closed_from=2024-03-01&closed_to=2024-03-31"),
}));
vi.mock("@/lib/actions/entity-search", () => ({ searchEntities: vi.fn() }));

describe("the filter bar renders the URL's typed filters into its boxes", () => {
  it("search and both dates", async () => {
    const { DealsFilters } = await import("@/components/features/deals/deals-filters");
    const html = renderToStaticMarkup(
      createElement(DealsFilters, {
        agents: [],
        values: { q: "Maria", closed_from: "2024-03-01", closed_to: "2024-03-31" },
        property: null,
        contact: null,
      }),
    );
    expect(html).toMatch(/<input[^>]*value="Maria"[^>]*aria-label="Search deals"|<input[^>]*aria-label="Search deals"[^>]*value="Maria"/);
    expect(html).toMatch(/<input[^>]*id="deals-closed-from"[^>]*value="2024-03-01"|<input[^>]*value="2024-03-01"[^>]*id="deals-closed-from"/);
    expect(html).toMatch(/<input[^>]*id="deals-closed-to"[^>]*value="2024-03-31"|<input[^>]*value="2024-03-31"[^>]*id="deals-closed-to"/);
  });
});
