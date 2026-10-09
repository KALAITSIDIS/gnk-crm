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

/** A read-back page that finds THE row this attempt inserted (its id is only known once the insert ran). */
const ATTEMPT_ROW = "attempt-row";
let lastFake: ReturnType<typeof fakeClient> | null = null;
function liveRow(page: FakePage): FakePage {
  if ((page.data as { id?: unknown } | null)?.id !== ATTEMPT_ROW) return page;
  return {
    error: null,
    get data() {
      const inserts = lastFake!.argsOf("property_media", "insert");
      return { id: (inserts[inserts.length - 1][0] as { id: string }).id };
    },
  };
}

function setup(s: Setup = {}) {
  const fake = fakeClient({
    properties: [
      s.property ?? {
        data: { id: PROPERTY_ID, org_id: ORG, visibility: "draft", assigned_agent_id: AGENT.id },
        error: null,
      },
    ],
    property_media: [{ data: [], error: null }, ...(s.media ?? [{ data: { id: "m-1" }, error: null }]).map(liveRow)],
  });
  lastFake = fake;
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
        { data: { id: ATTEMPT_ROW }, error: null }, // the read-back finds it
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
  it("a normal upload: one insert, NO read-back, saved", async () => {
    const h = setup();
    const res = await h.run();
    expect(res.error).toBeNull();
    expect(res.saved).toBe(1);
    expect(h.fake.argsOf("property_media", "maybeSingle")).toEqual([]);
    expect(leftovers()).toHaveLength(5);
  });

  it("the audit event fails: row and files kept, the upload is not reported as failed, the gap is reported", async () => {
    state.logEvent = async () => {
      throw new Error("logEvent failed (property.media_uploaded): boom");
    };
    const h = setup();
    const res = await h.run();
    expect(res.error).toBeNull();
    expect(res.savedAt).not.toBeNull();
    expect(res.warning).toMatch(/timeline/i);
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

/**
 * T-media-insert-outcome. A CODE on the insert's error is not, by itself, an
 * answer from the database. PGRST001 is PostgREST losing its own connection
 * mid-request; class 08 is a connection exception, which can arrive after the
 * COMMIT went through. Until this change any non-empty code counted as a
 * definite refusal and the attempt's objects were deleted without asking the
 * database — a committed row was left pointing at nothing.
 *
 * SIMULATED, not reproduced: the session client below is scripted. The insert
 * "commits" only in the sense that the read-back is told to find the row; no
 * database or network fault is injected here (the real-stack harness is
 * supabase/tests/media-upload-authz.test.ts).
 */
describe("a coded error is not proof the row was refused", () => {
  const AMBIGUOUS = [
    { code: "PGRST001", message: "Database client error. Retrying the connection." },
    { code: "08006", message: "connection failure" },
    { code: "08003", message: "connection does not exist" },
    // measured / shown from source to follow a committed transaction
    { code: "PGRST111", message: "Invalid response.headers" },
    { code: "PGRST112", message: "Invalid response.status" },
    { code: "57014", message: "canceling statement due to user request" },
    { code: "53200", message: "out of memory" },
    { code: "PGRST000", message: "Could not connect with the database." },
    // codes nobody here has classified: unknown, never a licence to delete
    { code: "PGRST999", message: "a future PostgREST error" },
    { code: "XX000", message: "internal error" },
    { code: "418", message: "a gateway's own JSON body" },
  ];
  const TRANSPORT = { code: "", message: "TypeError: fetch failed" };

  const insertedId = (h: ReturnType<typeof setup>) =>
    (h.fake.argsOf("property_media", "insert")[0][0] as { id: string }).id;
  const readBackIds = (h: ReturnType<typeof setup>) =>
    h.fake
      .argsOf("property_media", "eq")
      .filter(([col]) => col === "id")
      .map(([, v]) => v);

  it.each([...AMBIGUOUS, TRANSPORT])(
    "$code: the row DID commit — every object kept, reconciled by the attempt id, reported as saved",
    async (insertErr) => {
      const events: unknown[] = [];
      state.logEvent = async (...a) => void events.push(a);
      const h = setup({
        media: [
          { data: null, error: insertErr },
          { data: { id: ATTEMPT_ROW }, error: null }, // the read-back finds the row
        ],
      });
      const res = await h.run();
      const id = insertedId(h);
      expect(readBackIds(h), "no read-back by the attempt id").toEqual([id]);
      expect(store.removes, "objects of a committed row were removed").toEqual([]);
      expect(leftovers(), "committed media lost its files").toHaveLength(5);
      expect(leftovers().every((k) => k.includes(id))).toBe(true);
      expect(res.error).toBeNull();
      expect(res.saved).toBe(1);
      expect(events).toHaveLength(1);
      expect(foreignIntact()).toBe(true);
    },
  );

  it.each([...AMBIGUOUS, TRANSPORT])(
    "$code, and the read-back finds nothing: files kept, 'could not confirm', reported",
    async (insertErr) => {
      const h = setup({ media: [{ data: null, error: insertErr }, { data: null, error: null }] });
      const res = await h.run();
      expect(readBackIds(h)).toEqual([insertedId(h)]);
      expect(store.removes).toEqual([]);
      expect(leftovers()).toHaveLength(5);
      expect(res.error).toMatch(/could not confirm/i);
      expect(res.savedAt).toBeNull();
      expect(sentry.messages.some((m) => /outcome unknown/i.test(m.message))).toBe(true);
    },
  );

  it("PGRST001, and the read-back fails too: files kept, 'could not confirm'", async () => {
    const h = setup({
      media: [
        { data: null, error: AMBIGUOUS[0] },
        { data: null, error: { code: "PGRST001", message: "Database client error." } },
      ],
    });
    const res = await h.run();
    expect(store.removes).toEqual([]);
    expect(leftovers()).toHaveLength(5);
    expect(res.error).toMatch(/could not confirm/i);
  });

  it.each([
    { code: "42501", message: "new row violates row-level security policy for table \"property_media\"" },
    { code: "23514", message: "new row violates check constraint" },
    { code: "23503", message: "insert or update violates foreign key constraint" },
    { code: "PGRST204", message: "Could not find the 'x' column of 'property_media' in the schema cache" },
    { code: "PGRST301", message: "JWT expired" },
  ])("$code is a definite refusal: only this attempt's objects are removed, without a read-back", async (insertErr) => {
    const h = setup({ media: [{ data: null, error: insertErr }] });
    const res = await h.run();
    const id = insertedId(h);
    expect(readBackIds(h)).toEqual([]);
    expect(leftovers()).toEqual([]);
    expect(store.removes.flatMap((r) => r.paths).every((p) => p.includes(id))).toBe(true);
    expect(foreignIntact()).toBe(true);
    expect(res.error).not.toMatch(/could not confirm/i);
    expect(res.savedAt).toBeNull();
  });

  it("23505 on the attempt id: a row with THIS id exists — read back, never deleted", async () => {
    const h = setup({
      media: [
        { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"property_media_pkey\"" } },
        { data: { id: ATTEMPT_ROW }, error: null },
      ],
    });
    const res = await h.run();
    expect(readBackIds(h)).toEqual([insertedId(h)]);
    expect(store.removes).toEqual([]);
    expect(leftovers()).toHaveLength(5);
    expect(res.error).toBeNull();
    expect(res.saved).toBe(1);
  });

  it("a numeric code (a gateway's JSON body) is unknown, and nothing throws", async () => {
    const h = setup({
      media: [{ data: null, error: { code: 42501 as unknown as string, message: "Service Unavailable" } }, { data: null, error: null }],
    });
    const res = await h.run();
    expect(store.removes).toEqual([]);
    expect(leftovers()).toHaveLength(5);
    expect(res.error).toMatch(/could not confirm/i);
  });

  it("a 'success' that names no row is not counted as saved: read back first", async () => {
    const h = setup({ media: [{ data: null, error: null }, { data: null, error: null }] });
    const res = await h.run();
    expect(readBackIds(h)).toEqual([insertedId(h)]);
    expect(leftovers()).toHaveLength(5);
    expect(res.saved ?? 0).toBe(0);
    expect(res.error).toMatch(/could not confirm/i);
  });

  it.each([
    ["{} (a gateway's 2xx object)", {}],
    ["[] (postgrest-js's answer to a 404 with an array body)", []],
    ["another id", { id: "0d0d0d0d-0000-4000-8000-000000000001" }],
  ])("a read-back answering %s is not THIS row: 'could not confirm', nothing saved, no event", async (_label, data) => {
    const events: unknown[] = [];
    state.logEvent = async (...a) => void events.push(a);
    const h = setup({ media: [{ data: null, error: AMBIGUOUS[0] }, { data: data as never, error: null }] });
    const res = await h.run();
    expect(res.error).toMatch(/could not confirm/i);
    expect(res.saved ?? 0).toBe(0);
    expect(events).toEqual([]);
    expect(leftovers()).toHaveLength(5);
    expect(store.removes).toEqual([]);
  });

  it("a definite refusal without a message still cleans up and answers (never throws)", async () => {
    const h = setup({ media: [{ data: null, error: { code: "23514" } as never }] });
    const res = await h.run();
    expect(leftovers()).toEqual([]);
    expect(res.error).toMatch(/refused/);
  });

  it("a batch: the second file's insert is DEFINITELY refused — only its five objects go, the first file's stay", async () => {
    const h = setup({
      files: [jpeg("a.jpg"), jpeg("b.jpg")],
      media: [
        { data: { id: "m-1" }, error: null },
        { data: null, error: { code: "42501", message: "new row violates row-level security policy" } },
      ],
    });
    const res = await h.run();
    const [first, second] = h.fake.argsOf("property_media", "insert").map((a) => (a[0] as { id: string }).id);
    expect(leftovers()).toHaveLength(5);
    expect(leftovers().every((k) => k.includes(first))).toBe(true);
    expect(store.removes.flatMap((r) => r.paths).every((p) => p.includes(second))).toBe(true);
    expect(res.saved).toBe(1);
    expect(res.error).toMatch(/^1 of 2 saved, then b\.jpg: Upload not allowed/);
    expect(foreignIntact()).toBe(true);
  });

  it("a batch: the first insert answers PGRST001 and is reconciled as saved, the second saves normally — 2 saved", async () => {
    const events: unknown[] = [];
    state.logEvent = async (...a) => void events.push(a);
    const h = setup({
      files: [jpeg("a.jpg"), jpeg("b.jpg")],
      media: [
        { data: null, error: AMBIGUOUS[0] },
        { data: { id: ATTEMPT_ROW }, error: null },
        { data: { id: "m-2" }, error: null },
      ],
    });
    const res = await h.run();
    expect(res.error).toBeNull();
    expect(res.saved).toBe(2);
    expect(leftovers()).toHaveLength(10);
    expect(events).toHaveLength(2);
    expect(store.removes).toEqual([]);
  });

  it("a batch: the first file saved, the second's insert answers PGRST001 unconfirmed — all ten objects stay, '1 of 2 saved'", async () => {
    const h = setup({
      files: [jpeg("a.jpg"), jpeg("b.jpg")],
      media: [
        { data: { id: "m-1" }, error: null },
        { data: null, error: AMBIGUOUS[0] },
        { data: null, error: null },
      ],
    });
    const res = await h.run();
    expect(store.removes).toEqual([]);
    expect(leftovers()).toHaveLength(10);
    expect(res.saved).toBe(1);
    expect(res.error).toMatch(/^1 of 2 saved, then b\.jpg: could not confirm/);
    expect(quality.calls).toBe(1);
  });
});
