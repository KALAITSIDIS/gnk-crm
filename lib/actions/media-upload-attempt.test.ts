import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * One upload ATTEMPT of `uploadPropertyMedia`: who may start it, and what it
 * leaves behind when any part of it fails (DECISIONS T-media-upload-authz).
 *
 * Until this change the action took an org-wide property READ as permission to
 * upload, then processed the image and wrote five objects with the service
 * role before the session-authorised `property_media` insert said no. An
 * upload that failed part-way returned at once and left its successful
 * siblings in the buckets; `Promise.all` rejected on a thrown upload without
 * waiting for the others, so a slow sibling could land after the action had
 * already answered; and ANY insert error — a lost response included — deleted
 * the objects, even when the row behind that lost response had committed.
 *
 * The storage below is an in-memory pair of buckets that the action's REAL
 * pipeline writes into. Each upload can be told to answer normally, return an
 * error, throw, answer late, or store the object and then lose the answer —
 * the last two are what "ambiguous" means for an object store. The session
 * client is the scripted fake; the real database behaviour is pinned by
 * supabase/tests/media-upload-authz.test.ts.
 */

const PROPERTY_ID = "6a1e2f3a-4b5c-4d6e-8f7a-0b1c2d3e4f01";
const OTHER_PROPERTY_ID = "6a1e2f3a-4b5c-4d6e-8f7a-0b1c2d3e4f02";
const ORG = "org-1";

type Behaviour =
  | "ok"
  | "error" // the store refused: nothing written, an error returned
  | "throw" // the request blew up before anything was written
  | "stored-then-error" // written, but the answer said it failed
  | "stored-then-throw" // written, and then the connection dropped
  | { delayMs: number; then: Behaviour };

const store = vi.hoisted(() => ({
  objects: new Map<string, number>(), // "bucket/path" -> size
  uploads: [] as { bucket: string; path: string }[],
  removes: [] as { bucket: string; paths: string[] }[],
  plan: (() => "ok") as (bucket: string, path: string) => Behaviour,
  removeFails: false,
}));

const state = vi.hoisted(() => ({
  caller: null as unknown,
  profile: null as null | Error | { id: string; orgId: string; role: string; fullName: string },
  logEvent: null as null | ((...a: unknown[]) => Promise<void>),
}));

const sentry = vi.hoisted(() => ({ messages: [] as { message: string; ctx: unknown }[] }));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, ctx: unknown) => sentry.messages.push({ message, ctx }),
  captureException: () => {},
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: Blob) => {
          store.uploads.push({ bucket, path });
          const run = async (b: unknown): Promise<unknown> => {
            if (typeof b === "object" && b && "delayMs" in b) {
              const d = b as { delayMs: number; then: unknown };
              await new Promise((r) => setTimeout(r, d.delayMs));
              return run(d.then);
            }
            const key = `${bucket}/${path}`;
            switch (b) {
              case "error":
                return { data: null, error: { message: "store refused", status: 500 } };
              case "throw":
                throw new TypeError("fetch failed");
              case "stored-then-error":
                store.objects.set(key, body.size);
                return { data: null, error: { message: "gateway timeout", status: 504 } };
              case "stored-then-throw":
                store.objects.set(key, body.size);
                throw new TypeError("fetch failed (answer lost)");
              default:
                if (store.objects.has(key)) {
                  return { data: null, error: { message: "The resource already exists", status: 409, statusCode: "409" } };
                }
                store.objects.set(key, body.size);
                return { data: { path }, error: null };
            }
          };
          return run(store.plan(bucket, path));
        },
        download: async () => ({ data: null, error: { message: "not found" } }),
        remove: async (paths: string[]) => {
          store.removes.push({ bucket, paths });
          if (store.removeFails) return { data: null, error: { message: "storage unavailable" } };
          const gone = paths.filter((p) => store.objects.delete(`${bucket}/${p}`));
          return { data: gone.map((name) => ({ name })), error: null };
        },
        exists: async (path: string) => ({ data: store.objects.has(`${bucket}/${path}`), error: null }),
      }),
    },
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => {
    if (state.profile instanceof Error) throw state.profile;
    return state.profile;
  },
}));
vi.mock("@/lib/services/events", () => ({
  logEvent: (...a: unknown[]) => (state.logEvent ? state.logEvent(...a) : Promise.resolve()),
}));
const quality = vi.hoisted(() => ({ calls: 0, throws: false }));
vi.mock("@/lib/services/quality-score", () => {
  const run = async () => {
    quality.calls++;
    if (quality.throws) throw new Error("score write failed");
    return null;
  };
  return { recomputeQualityScore: run, recomputeQuietly: async () => { try { await run(); } catch { /* quiet */ } } };
});
vi.mock("@/lib/services/site-revalidate", () => ({ notifySiteIfPublic: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const processed = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/services/media", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/services/media")>();
  return {
    ...real,
    processPropertyImage: async (...a: Parameters<typeof real.processPropertyImage>) => {
      processed.calls++;
      return real.processPropertyImage(...a);
    },
  };
});

const { uploadPropertyMedia } = await import("@/lib/actions/media");

const source = await sharp({
  create: { width: 60, height: 40, channels: 3, background: { r: 40, g: 120, b: 80 } },
})
  .jpeg()
  .toBuffer();

const ADMIN = { id: "u-admin", orgId: ORG, role: "admin", fullName: "A" };
const LM = { id: "u-lm", orgId: ORG, role: "listing_manager", fullName: "L" };
const AGENT = { id: "u-agent", orgId: ORG, role: "agent", fullName: "G" };

/** Objects that belong to someone else and must survive every failure below. */
const FOREIGN = [
  `media/properties/${PROPERTY_ID}/0b0b0b0b-0000-4000-8000-000000000001_thumb.webp`,
  `documents/properties/${PROPERTY_ID}/original/0b0b0b0b-0000-4000-8000-000000000001.jpg`,
  `media/properties/${OTHER_PROPERTY_ID}/0c0c0c0c-0000-4000-8000-000000000001_full.webp`,
];

beforeEach(() => {
  store.objects.clear();
  for (const k of FOREIGN) store.objects.set(k, 1);
  store.uploads.length = 0;
  store.removes.length = 0;
  store.plan = () => "ok";
  store.removeFails = false;
  state.profile = ADMIN;
  state.logEvent = null;
  sentry.messages.length = 0;
  quality.calls = 0;
  quality.throws = false;
  processed.calls = 0;
});

interface Setup {
  kind?: "photo" | "floor_plan";
  files?: File[];
  property?: FakePage;
  /** the scripted answers after the gallery read: inserts, read-backs */
  media?: FakePage[];
  propertyId?: string;
}

function jpeg(name = "front.jpg") {
  return new File([source], name, { type: "image/jpeg" });
}

function setup(s: Setup = {}) {
  const fake = fakeClient({
    properties: [
      s.property ?? {
        data: { id: PROPERTY_ID, org_id: ORG, visibility: "draft", assigned_agent_id: AGENT.id },
        error: null,
      },
    ],
    property_media: [{ data: [], error: null }, ...(s.media ?? [{ data: { id: "m-1" }, error: null }])],
  });
  state.caller = fake.client;
  const form = new FormData();
  form.set("property_id", s.propertyId ?? PROPERTY_ID);
  form.set("kind", s.kind ?? "photo");
  for (const f of s.files ?? [jpeg()]) form.append("files", f);
  return {
    fake,
    run: () => uploadPropertyMedia({ error: null, savedAt: null }, form),
    inserts: () => fake.argsOf("property_media", "insert").length,
  };
}

/** Objects this test's attempts wrote that are still there. */
const leftovers = () => [...store.objects.keys()].filter((k) => !FOREIGN.includes(k));
const foreignIntact = () => FOREIGN.every((k) => store.objects.has(k));
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe("who may start an upload — decided before any privileged work", () => {
  it("a same-organisation agent who can READ the listing but is not assigned: nothing processed, nothing uploaded", async () => {
    state.profile = { ...AGENT, id: "u-other-agent" };
    const h = setup();
    const res = await h.run();
    expect(res.error).toMatch(/not allowed|assigned/i);
    expect(processed.calls, "the image was processed for a caller who may not upload").toBe(0);
    expect(store.uploads, "privileged uploads ran for a caller who may not upload").toEqual([]);
    expect(h.inserts()).toBe(0);
  });

  it("a listing that is another organisation's: refused before any upload, whatever the read returned", async () => {
    const h = setup({
      property: { data: { id: PROPERTY_ID, org_id: "org-2", visibility: "draft", assigned_agent_id: null }, error: null },
    });
    const res = await h.run();
    expect(res.error).toBeTruthy();
    expect(store.uploads).toEqual([]);
    expect(processed.calls).toBe(0);
  });

  it("a listing the caller cannot read: not found, nothing uploaded", async () => {
    const h = setup({ property: { data: null, error: null } });
    expect((await h.run()).error).toMatch(/not found/i);
    expect(store.uploads).toEqual([]);
  });

  it("the permission read FAILS: refused (fail closed), nothing uploaded", async () => {
    const h = setup({ property: { data: null, error: { message: "connection reset", code: "" } } });
    const res = await h.run();
    expect(res.error).toBeTruthy();
    expect(store.uploads).toEqual([]);
    expect(processed.calls).toBe(0);
  });

  it.each([
    ["unauthenticated", "Not authenticated"],
    ["aal1 / deactivated (the RLS profile read comes back empty)", "Profile not found for authenticated user"],
    ["deactivated (pre-0014 belt)", "Account deactivated"],
  ])("%s: an error RESULT (not a throw), nothing read with privilege, nothing uploaded", async (_label, why) => {
    state.profile = new Error(why);
    const h = setup();
    const res = await h.run();
    expect(res.error).toBeTruthy();
    expect(store.uploads).toEqual([]);
    expect(processed.calls).toBe(0);
  });

  it("a malformed property id is refused before anything is read", async () => {
    const h = setup({ propertyId: "../../etc" });
    const res = await h.run();
    expect(res.error).toBeTruthy();
    expect(h.fake.calls.length).toBe(0);
    expect(store.uploads).toEqual([]);
  });

  it.each([
    ["admin", ADMIN],
    ["listing manager", LM],
    ["the assigned agent", AGENT],
  ])("%s keeps their access: five objects, one row, one event", async (_label, who) => {
    state.profile = who;
    const events: unknown[] = [];
    state.logEvent = async (...a) => void events.push(a);
    const h = setup();
    expect((await h.run()).error).toBeNull();
    expect(leftovers()).toHaveLength(5);
    expect(h.inserts()).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("a floor plan by the assigned agent: four objects, all in the private bucket", async () => {
    state.profile = AGENT;
    const h = setup({ kind: "floor_plan" });
    expect((await h.run()).error).toBeNull();
    expect(leftovers()).toHaveLength(4);
    expect(leftovers().every((k) => k.startsWith("documents/"))).toBe(true);
  });
});

describe("a failed upload leaves none of its objects behind", () => {
  const NAMES = ["/original/", "_thumb.webp", "_card.webp", "_full.webp", "_jpeg.jpg"];

  it.each(NAMES)("%s returns an error: every sibling removed, no row", async (which) => {
    store.plan = (_b, p) => (p.includes(which) ? "error" : "ok");
    const h = setup();
    const res = await h.run();
    expect(res.error).toMatch(/upload failed/i);
    expect(leftovers()).toEqual([]);
    expect(h.inserts()).toBe(0);
    expect(foreignIntact()).toBe(true);
  });

  it.each(NAMES)("%s THROWS: every sibling removed, an error result, no row", async (which) => {
    store.plan = (_b, p) => (p.includes(which) ? "throw" : "ok");
    const h = setup();
    const res = await h.run();
    expect(res.error).toMatch(/upload failed/i);
    expect(leftovers()).toEqual([]);
    expect(h.inserts()).toBe(0);
  });

  it("a SLOW sibling is waited for: it cannot land after the cleanup", async () => {
    store.plan = (_b, p) =>
      p.includes("_thumb") ? "throw" : p.includes("_full") ? { delayMs: 60, then: "ok" } : "ok";
    const h = setup();
    const res = await h.run();
    expect(res.error).toBeTruthy();
    await settle(); // anything still in flight would land now
    expect(leftovers(), "a late upload recreated an object after the cleanup").toEqual([]);
    expect(h.inserts()).toBe(0);
  });

  it.each(["stored-then-error", "stored-then-throw"] as const)(
    "an AMBIGUOUS upload (%s — written, answer lost) is removed too",
    async (mode) => {
      store.plan = (_b, p) => (p.includes("_card") ? mode : "ok");
      const h = setup();
      expect((await h.run()).error).toBeTruthy();
      expect(leftovers()).toEqual([]);
    },
  );

  it("a floor plan's failure cleans the PRIVATE bucket", async () => {
    store.plan = (_b, p) => (p.includes("_full") ? "error" : "ok");
    const h = setup({ kind: "floor_plan" });
    expect((await h.run()).error).toBeTruthy();
    expect(leftovers()).toEqual([]);
  });

  it("the cleanup itself fails: the result says files may remain, and it is reported", async () => {
    store.plan = (_b, p) => (p.includes("_jpeg") ? "error" : "ok");
    store.removeFails = true;
    const h = setup();
    const res = await h.run();
    expect(res.error).toMatch(/could not be removed|may remain/i);
    expect(sentry.messages.some((m) => /media upload/i.test(m.message))).toBe(true);
  });

  it("cleanup is idempotent and scoped: a repeat failure removes only that attempt's objects", async () => {
    store.plan = (_b, p) => (p.includes("_thumb") ? "error" : "ok");
    await setup().run();
    await setup().run();
    expect(leftovers()).toEqual([]);
    expect(foreignIntact(), "another attempt's or listing's objects were removed").toBe(true);
    const removed = store.removes.flatMap((r) => r.paths);
    expect(removed.every((p) => p.startsWith(`properties/${PROPERTY_ID}/`))).toBe(true);
    expect(removed.some((p) => FOREIGN.some((f) => f.endsWith(p)))).toBe(false);
  });
});

describe("the media row: definite rejection versus unknown outcome", () => {
  it("a DEFINITE rejection (RLS 42501) removes the attempt's objects", async () => {
    const h = setup({ media: [{ data: null, error: { message: "new row violates row-level security policy", code: "42501" } }] });
    const res = await h.run();
    expect(res.error).toMatch(/not allowed|assigned/i);
    expect(leftovers()).toEqual([]);
    expect(foreignIntact()).toBe(true);
  });

  it("a LOST answer whose row DID commit: files kept, reported as saved", async () => {
    const events: unknown[] = [];
    state.logEvent = async (...a) => void events.push(a);
    const h = setup({
      media: [
        { data: null, error: { message: "TypeError: fetch failed", code: "" } },
        { data: { id: "m-1" }, error: null }, // the read-back finds it
      ],
    });
    const res = await h.run();
    expect(res.error).toBeNull();
    expect(leftovers(), "committed media lost its files").toHaveLength(5);
    expect(events).toHaveLength(1);
  });

  it("a LOST answer that cannot be confirmed either way: files NOT deleted, the outcome reported as unknown", async () => {
    const h = setup({
      media: [
        { data: null, error: { message: "TypeError: fetch failed", code: "" } },
        { data: null, error: { message: "TypeError: fetch failed", code: "" } },
      ],
    });
    const res = await h.run();
    expect(res.error).toMatch(/could not confirm/i);
    expect(leftovers(), "an unknown outcome deleted files a committed row may reference").toHaveLength(5);
    expect(sentry.messages.some((m) => /unknown|unconfirmed/i.test(m.message))).toBe(true);
  });
});

describe("after the row commits, nothing turns it into a failure", () => {
  it("the audit event fails: row and files kept, the upload is not reported as failed, the gap is reported", async () => {
    state.logEvent = async () => {
      throw new Error("logEvent failed (property.media_uploaded): boom");
    };
    const h = setup();
    const res = await h.run();
    expect(res.error).toBeNull();
    expect(res.savedAt).not.toBeNull();
    expect(leftovers()).toHaveLength(5);
    expect(store.removes).toEqual([]);
    expect(sentry.messages.some((m) => /event/i.test(m.message))).toBe(true);
  });

  it("the quality-score refresh fails: still a success", async () => {
    quality.throws = true;
    const h = setup();
    const res = await h.run();
    expect(res.error).toBeNull();
    expect(leftovers()).toHaveLength(5);
  });
});

describe("several files in one request", () => {
  it("the whole batch is validated before anything is written", async () => {
    const h = setup({ files: [jpeg("a.jpg"), new File(["x"], "b.gif", { type: "image/gif" })] });
    const res = await h.run();
    expect(res.error).toMatch(/b\.gif/);
    expect(store.uploads).toEqual([]);
    expect(processed.calls).toBe(0);
  });

  it("a later file fails: the earlier one stays, and the result says how many were saved", async () => {
    let n = 0;
    store.plan = (_b, p) => {
      if (p.includes("/original/")) n++;
      return n === 2 && p.includes("_card") ? "error" : "ok";
    };
    const h = setup({
      files: [jpeg("a.jpg"), jpeg("b.jpg")],
      media: [{ data: { id: "m-1" }, error: null }, { data: { id: "m-2" }, error: null }],
    });
    const res = await h.run();
    expect(res.error).toMatch(/1 of 2/);
    expect(res.saved).toBe(1);
    expect(leftovers(), "the first file's committed objects were erased").toHaveLength(5);
    expect(h.inserts()).toBe(1);
    expect(quality.calls, "the committed file's score refresh was skipped").toBe(1);
  });
});
