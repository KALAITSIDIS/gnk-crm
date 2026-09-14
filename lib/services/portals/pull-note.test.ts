import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { notePortalPull, notePortalPullAfter, type PullNote } from "./pull-note";

/**
 * The note is the one thing on the feed's path that may fail without the
 * portal ever knowing, so both of its promises are pinned here rather than
 * left to the route: a failure is swallowed (the portal already has its
 * bytes), and outside a request scope the note still happens — `after()`
 * throws there, and a fallback that had quietly stopped running would leave
 * "last pulled" frozen with the suite green.
 */
const scope = vi.hoisted(() => ({ /** false → after() throws, as outside a request */ inRequest: true }));

vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    if (!scope.inRequest) throw new Error("`after` was called outside a request scope");
    void fn();
  },
}));

const NOTE: PullNote = {
  token: "f".repeat(64),
  userAgent: "KyeroBot/1.0",
  count: 7,
  portalId: "jamesedition",
};

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

/** `result` is what note_portal_pull answers; `throws` makes the call itself blow up. */
const client = (result: { error: { message: string } | null }, throws?: Error) =>
  ({
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (throws) throw throws;
      return Promise.resolve({ data: null, ...result });
    },
  }) as unknown as SupabaseClient<Database>;

const warned = () =>
  vi
    .mocked(console.warn)
    .mock.calls.map((c: unknown[]) => c.map(String).join(" "))
    .join("\n");

beforeEach(() => {
  calls.length = 0;
  scope.inRequest = true;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("notePortalPull", () => {
  it("notes the pull and passes 0095's three arguments", async () => {
    expect(await notePortalPull(client({ error: null }), NOTE)).toBe("noted");
    expect(calls).toEqual([
      {
        name: "note_portal_pull",
        args: { p_token: NOTE.token, p_ua: NOTE.userAgent, p_count: NOTE.count },
      },
    ]);
    expect(warned()).toBe("");
  });

  it("swallows a database error, names the portal, and never logs the token", async () => {
    const supabase = client({ error: { message: "permission denied for function" } });
    await expect(notePortalPull(supabase, NOTE)).resolves.toBe("failed");
    const text = warned();
    expect(text).toContain("jamesedition");
    expect(text).toContain("permission denied for function");
    // the token is the whole of the caller's proof; a log line is not where it goes
    expect(text).not.toContain(NOTE.token);
  });

  it("swallows a thrown call rather than rejecting into the feed", async () => {
    const supabase = client({ error: null }, new Error("socket hang up"));
    await expect(notePortalPull(supabase, NOTE)).resolves.toBe("failed");
    expect(warned()).toContain("socket hang up");
  });
});

describe("notePortalPullAfter", () => {
  it("runs the note through after() when there is a request scope", () => {
    notePortalPullAfter(client({ error: null }), NOTE);
    expect(calls.map((c) => c.name)).toEqual(["note_portal_pull"]);
  });

  it("still notes the pull inline when after() throws — a script, or a unit test", () => {
    scope.inRequest = false;
    expect(() => notePortalPullAfter(client({ error: null }), NOTE)).not.toThrow();
    expect(calls.map((c) => c.name)).toEqual(["note_portal_pull"]);
  });

  it("never throws at the caller, whichever way the note fails", () => {
    scope.inRequest = false;
    expect(() =>
      notePortalPullAfter(client({ error: null }, new Error("socket hang up")), NOTE),
    ).not.toThrow();
  });
});
