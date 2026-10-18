import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { recordPortalPull, recordPortalPullAfter, type PullRecord } from "./pull-note";

/**
 * The pull record is the one write on the feed's path that may fail without
 * the portal ever knowing, so its promises are pinned here rather than left to
 * the route: a failure is swallowed (the portal already has its bytes), the
 * admin client is built only when the record runs — after the response — and
 * outside a request scope the record still happens: `after()` throws there,
 * and a fallback that had quietly stopped running would freeze "last
 * requested" with the suite green.
 */
const scope = vi.hoisted(() => ({
  /** false → after() throws, as outside a request */
  inRequest: true,
  /** what after() was handed, run by finishResponse() */
  scheduled: [] as Array<() => unknown>,
}));

vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    if (!scope.inRequest) throw new Error("`after` was called outside a request scope");
    scope.scheduled.push(fn);
  },
}));

/** The response has gone out: run what after() was handed. */
async function finishResponse() {
  for (const fn of scope.scheduled.splice(0)) await fn();
}

/** Let an un-awaited (inline) record reach its end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const TOKEN = "0123456789abcdef".repeat(4);
const DIGEST = createHash("sha256").update(TOKEN).digest("hex");

const SERVED: PullRecord = {
  token: TOKEN,
  userAgent: "KyeroBot/1.0",
  outcome: "served",
  served: 7,
  selected: 9,
  excluded: 2,
  reason: null,
  detail: { too_few_photos: 2, revisions: "synced" },
  portalId: "jamesedition",
};

const FAILED: PullRecord = {
  token: TOKEN,
  userAgent: "KyeroBot/1.0",
  outcome: "failed",
  served: null,
  selected: null,
  excluded: null,
  reason: "listings_failed",
  detail: {},
  portalId: "jamesedition",
};

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
let built = 0;

/** A makeClient whose client answers `result`, or whose rpc throws `throws`. */
const clientFactory =
  (result: { error: { message: string; code?: string } | null }, throws?: Error) => (): SupabaseClient<Database> => {
    built++;
    return {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (throws) throw throws;
        return Promise.resolve({ data: null, ...result });
      },
    } as unknown as SupabaseClient<Database>;
  };

/** supabase-js throws on construction when the service key is missing. */
const refusingFactory = (): SupabaseClient<Database> => {
  built++;
  throw new Error("supabaseKey is required.");
};

const warned = () =>
  vi
    .mocked(console.warn)
    .mock.calls.map((c: unknown[]) => c.map(String).join(" "))
    .join("\n");

beforeEach(() => {
  calls.length = 0;
  built = 0;
  scope.inRequest = true;
  scope.scheduled.length = 0;
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("recordPortalPull", () => {
  it("records the pull with 0150's arguments — the plaintext token, which the function hashes itself", async () => {
    expect(await recordPortalPull(clientFactory({ error: null }), SERVED)).toBe("recorded");
    expect(calls).toEqual([
      {
        name: "record_portal_pull",
        args: {
          p_token: TOKEN,
          p_ua: "KyeroBot/1.0",
          p_outcome: "served",
          p_served: 7,
          p_selected: 9,
          p_excluded: 2,
          p_reason: null,
          p_detail: { too_few_photos: 2, revisions: "synced" },
        },
      },
    ]);
    // 0151 dropped the digest-taking note_portal_pull: a digest here would find no connection
    expect(calls[0]!.args.p_token).not.toBe(DIGEST);
    expect(Object.keys(calls[0]!.args)).not.toContain("p_token_sha256");
    expect(built).toBe(1);
    expect(warned()).toBe("");
  });

  it("passes unknown counts as null — never 0, which would read as 'served nothing'", async () => {
    expect(await recordPortalPull(clientFactory({ error: null }), FAILED)).toBe("recorded");
    expect(calls[0]!.args).toMatchObject({
      p_outcome: "failed",
      p_served: null,
      p_selected: null,
      p_excluded: null,
      p_reason: "listings_failed",
      p_detail: {},
    });
  });

  it("swallows a database error, names the portal, and never logs the token or its digest", async () => {
    const makeClient = clientFactory({ error: { message: "permission denied for function record_portal_pull" } });
    await expect(recordPortalPull(makeClient, SERVED)).resolves.toBe("failed");
    const text = warned();
    expect(text).toContain("jamesedition");
    expect(text).toContain("permission denied for function record_portal_pull");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(DIGEST);
  });

  it("words an error with no message by its code", async () => {
    await expect(recordPortalPull(clientFactory({ error: { message: "", code: "42501" } }), SERVED)).resolves.toBe(
      "failed",
    );
    expect(warned()).toContain("code 42501");
  });

  it("swallows a client that cannot be built (a missing service key) — a warning, never a 500", async () => {
    await expect(recordPortalPull(refusingFactory, SERVED)).resolves.toBe("failed");
    expect(calls).toEqual([]);
    const text = warned();
    expect(text).toContain("jamesedition");
    expect(text).toContain("supabaseKey is required.");
    expect(text).not.toContain(TOKEN);
  });

  it("swallows a thrown or rejected call rather than rejecting into the feed", async () => {
    await expect(recordPortalPull(clientFactory({ error: null }, new Error("socket hang up")), SERVED)).resolves.toBe(
      "failed",
    );
    expect(warned()).toContain("socket hang up");

    const rejecting = (): SupabaseClient<Database> =>
      ({ rpc: () => Promise.reject(new Error("fetch failed")) }) as unknown as SupabaseClient<Database>;
    await expect(recordPortalPull(rejecting, SERVED)).resolves.toBe("failed");
    expect(warned()).toContain("fetch failed");
    expect(warned()).not.toContain(TOKEN);
  });
});

describe("recordPortalPullAfter", () => {
  it("runs the record through after() — nothing, not even the client, before the response is done", async () => {
    recordPortalPullAfter(clientFactory({ error: null }), SERVED);
    expect(built).toBe(0);
    expect(calls).toEqual([]);
    await finishResponse();
    expect(built).toBe(1);
    expect(calls.map((c) => c.name)).toEqual(["record_portal_pull"]);
    expect(calls[0]!.args.p_token).toBe(TOKEN);
  });

  it("still records the pull inline when after() throws — a script, or a unit test", async () => {
    scope.inRequest = false;
    expect(() => recordPortalPullAfter(clientFactory({ error: null }), SERVED)).not.toThrow();
    await settle();
    expect(calls.map((c) => c.name)).toEqual(["record_portal_pull"]);
    expect(scope.scheduled).toEqual([]);
  });

  it("never throws at the caller, whichever way the record fails, in a request or out of one", async () => {
    expect(() => recordPortalPullAfter(refusingFactory, SERVED)).not.toThrow();
    await finishResponse(); // the scheduled record swallows the refusal too
    scope.inRequest = false;
    expect(() => recordPortalPullAfter(refusingFactory, SERVED)).not.toThrow();
    expect(() => recordPortalPullAfter(clientFactory({ error: null }, new Error("socket hang up")), SERVED)).not.toThrow();
    await settle();
    expect(warned()).toContain("supabaseKey is required.");
    expect(warned()).toContain("socket hang up");
    expect(warned()).not.toContain(TOKEN);
  });
});
