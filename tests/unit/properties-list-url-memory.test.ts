import { afterEach, describe, expect, it, vi } from "vitest";
import { PROPERTIES_LIST_CONTEXT_KEY } from "@/lib/constants/list-context";
import { rememberPropertiesListUrl } from "@/components/features/properties/remember-list-url";

/**
 * The writing half of "the record page's Properties link returns to the list
 * you came from" (A03): the list's filter bar and the map remember each
 * settled URL in the tab's sessionStorage. Only a properties list or map URL
 * is ever written, and storage that refuses is a convenience lost, never an
 * error on the list.
 */
const g = globalThis as unknown as { window?: unknown };

function withStorage(setItem: (key: string, value: string) => void) {
  g.window = { sessionStorage: { setItem } };
}

afterEach(() => {
  delete g.window;
});

describe("rememberPropertiesListUrl", () => {
  it("writes the settled list or map URL under the shared key", () => {
    const setItem = vi.fn();
    withStorage(setItem);
    rememberPropertiesListUrl("/properties?district=x&type=land&plot_min=1500&sort=plot_desc&page=2");
    rememberPropertiesListUrl("/properties");
    rememberPropertiesListUrl("/properties/map?type=land");
    expect(setItem.mock.calls).toEqual([
      [PROPERTIES_LIST_CONTEXT_KEY, "/properties?district=x&type=land&plot_min=1500&sort=plot_desc&page=2"],
      [PROPERTIES_LIST_CONTEXT_KEY, "/properties"],
      [PROPERTIES_LIST_CONTEXT_KEY, "/properties/map?type=land"],
    ]);
  });

  it("never writes anything that is not a properties list or map URL", () => {
    const setItem = vi.fn();
    withStorage(setItem);
    for (const url of [
      "/properties/123",
      "/properties/worklist",
      "/propertiesX",
      "/contacts?q=x",
      "https://elsewhere.example/properties",
      "//elsewhere.example/properties",
      "",
    ]) {
      rememberPropertiesListUrl(url);
    }
    expect(setItem).not.toHaveBeenCalled();
  });

  it("storage that refuses (a private window, a quota, no window at all) is swallowed", () => {
    withStorage(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => rememberPropertiesListUrl("/properties?type=land")).not.toThrow();
    delete g.window;
    expect(() => rememberPropertiesListUrl("/properties?type=land")).not.toThrow();
  });
});
