import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * Signing a slip is three writes to two systems — PNG to Storage, PDF to
 * Storage, a row to the database — and it used to do them in the one order
 * that could not be retried (integrations audit 2026-09-15, INT-08): the PNG
 * went up FIRST with `upsert: false`, then the PDF was rendered and uploaded,
 * then the row inserted. A PDF that failed to render or upload left the PNG
 * in Storage with no row, and the agent's second attempt was refused by
 * Storage ("already exists") for as long as the object lived.
 *
 * INT-08 answered with a pre-clean: remove whatever sat at the slip's two
 * paths before uploading, on the word of a "not signed yet" check. That check
 * was a `maybeSingle` whose error was never read, and a hollow answer is "no
 * row" to a `maybeSingle` — so a failed check DESTROYED a signed slip's files;
 * and a concurrent attempt's honest check destroyed the other's files just
 * uploaded (T-signed-slip-kept, measured on the real stack). Now: the check is
 * a list read through `rowsOf` on the service role; nothing is removed before
 * the upload — creating the PNG (`upsert: false`) is the attempt's claim; a
 * taken path is cleared only when its files are older than any live attempt
 * and the viewing is still unsigned; and an insert whose answer is unclear is
 * re-read before anything is taken back.
 *
 * What is pinned here (no database — supabase/tests/slip-null-answers.test.ts
 * runs the real action on the real stack): the order, the refusals, and which
 * objects each path removes.
 */
const state = vi.hoisted(() => ({
  client: null as unknown,
  admin: null as unknown,
  storage: [] as Array<{ op: "upload" | "remove" | "list"; paths: string[]; upsert?: boolean }>,
  failPdfUpload: false,
  pngTaken: false,
  pngError: null as null | { message: string; statusCode?: string },
  /** how many PDF uploads answer 409 before one succeeds */
  pdfTaken: 0,
  listed: [] as Array<{ name: string; created_at: string }>,
  listFails: false,
  removeFails: false,
  renderThrows: false,
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "admin", fullName: "A. Agent" }),
}));
vi.mock("@/lib/services/slip-pdf", () => ({
  renderSlipPdf: async () => {
    if (state.renderThrows) throw new Error("font missing");
    return Buffer.from("%PDF-1.4 fake");
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => (state.admin as { from: (t: string) => unknown }).from(t),
    storage: {
      from: () => ({
        upload: async (path: string, _body: unknown, opts: { upsert?: boolean }) => {
          state.storage.push({ op: "upload", paths: [path], upsert: opts?.upsert });
          if (path.endsWith(".png") && state.pngError) return { data: null, error: state.pngError };
          if (state.pngTaken && path.endsWith(".png")) {
            return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
          }
          if (path.endsWith(".pdf") && state.pdfTaken > 0) {
            state.pdfTaken -= 1;
            return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
          }
          if (state.failPdfUpload && path.endsWith(".pdf")) {
            return { data: null, error: { message: "upload failed: 503" } };
          }
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          state.storage.push({ op: "remove", paths });
          return state.removeFails ? { data: null, error: { message: "storage unavailable" } } : { data: [], error: null };
        },
        list: async (prefix: string) => {
          state.storage.push({ op: "list", paths: [prefix] });
          return state.listFails ? { data: null, error: { message: "storage unavailable" } } : { data: state.listed, error: null };
        },
      }),
    },
  }),
}));
const logEvent = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { signViewingSlip } = await import("@/lib/actions/viewing-slips");

const VIEWING_ID = "8f1c3c6a-3f7b-4b6e-9d2a-1a2b3c4d5e6f";
const PNG = `org-1/${VIEWING_ID}.png`;
const PDF = `org-1/${VIEWING_ID}.pdf`;
const PNG_BYTES = Buffer.from("png-bytes");
const SHA = createHash("sha256").update(PNG_BYTES).digest("hex");
const NONE: FakePage = { data: [], error: null };
const SAVED: FakePage = { data: [{ id: "slip-1" }], error: null };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const IN_PROGRESS = "Another signing of this viewing is in progress, or one that did not finish left its files — try again in 5 minutes.";

const viewing = {
  id: VIEWING_ID,
  org_id: "org-1",
  agent_id: "actor-1",
  scheduled_at: "2026-09-15T10:00:00.000Z",
  status: "scheduled",
  properties: { reference: "PAF0001", address: null },
  agent: { full_name: "A. Agent" },
};

/** The service role's slip reads (the check, then any re-read), the session's insert, the organisation. */
function setup(opts: { slipReads?: FakePage[]; insert?: FakePage; org?: FakePage } = {}) {
  state.storage = [];
  state.failPdfUpload = false;
  state.pngTaken = false;
  state.pngError = null;
  state.pdfTaken = 0;
  state.listed = [];
  state.listFails = false;
  state.removeFails = false;
  state.renderThrows = false;
  logEvent.mockClear();
  const session = fakeClient({
    viewings: [{ data: viewing, error: null }],
    viewing_slips: [opts.insert ?? SAVED],
    organizations: [opts.org ?? { data: { name: "Test Agency" }, error: null }],
  });
  const admin = fakeClient({ viewing_slips: opts.slipReads ?? [NONE] });
  state.client = session.client;
  state.admin = admin.client;
  return { session, admin };
}

function form(): FormData {
  const fd = new FormData();
  fd.set("viewing_id", VIEWING_ID);
  fd.set("signer_name", "A Buyer");
  fd.set("signature_data", `data:image/png;base64,${PNG_BYTES.toString("base64")}`);
  return fd;
}

const sign = () => signViewingSlip({ error: null, savedAt: null }, form());
const ops = () => state.storage.map((s) => `${s.op}:${s.paths.join(",")}`);
const removals = () => state.storage.filter((s) => s.op === "remove");

describe("signing a slip is retry-safe", () => {
  it("renders the PDF before anything is stored: a render failure strands nothing", async () => {
    setup();
    state.renderThrows = true;
    const r = await sign();
    expect(r.error).toContain("Could not render slip PDF");
    expect(state.storage, "no upload and no removal happened").toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("removes NOTHING before the upload: PNG (the claim) and PDF, neither overwriting, then the insert", async () => {
    const { session } = setup();
    const r = await sign();
    expect(r.error).toBeNull();
    expect(ops()).toEqual([`upload:${PNG}`, `upload:${PDF}`]);
    expect(state.storage.map((s) => s.upsert)).toEqual([false, false]);
    expect(session.argsOf("viewing_slips", "insert")).toHaveLength(1);
    expect(session.argsOf("viewing_slips", "select")).toEqual([["id"]]);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("the 'already signed?' check is a list read by the service role, bounded by the org and the viewing", async () => {
    const { admin } = setup();
    await sign();
    expect(admin.argsOf("viewing_slips", "eq")).toEqual([
      ["org_id", "org-1"],
      ["viewing_id", VIEWING_ID],
    ]);
    expect(admin.argsOf("viewing_slips", "limit")).toEqual([[1]]);
  });

  it("a failed PDF upload takes the PNG back out", async () => {
    const { session } = setup();
    state.failPdfUpload = true;
    const r = await sign();
    expect(r.error).toContain("upload failed");
    expect(ops().at(-1)).toBe(`remove:${PNG}`);
    expect(session.argsOf("viewing_slips", "insert")).toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a failed row insert, confirmed absent by a re-read, takes both objects back out", async () => {
    setup({ slipReads: [NONE, NONE], insert: { data: null, error: { message: "connection reset", code: "XX000" } } });
    const r = await sign();
    expect(r.error).toBe("connection reset");
    expect(ops().at(-1)).toBe(`remove:${PNG},${PDF}`);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a slip signed by someone else in between is reported as such, and this attempt's uploads are taken back out", async () => {
    setup({ insert: { data: null, error: { message: "duplicate key", code: "23505" } } });
    const r = await sign();
    expect(r.error).toBe("This viewing already has a signed slip.");
    expect(ops().at(-1)).toBe(`remove:${PNG},${PDF}`);
  });
});

describe("a signed slip's files are never removed on an unclear answer (T-signed-slip-kept)", () => {
  it.each<[string, FakePage, string]>([
    ["an empty-bodied OK answer", { data: null, error: null, status: 200 } as FakePage, "the signed slip: the answer held no rows (HTTP 200)"],
    ["a falsy error (a 500 whose body is 0)", { data: null, error: 0, status: 500 } as unknown as FakePage, "the signed slip: the answer held no rows (HTTP 500)"],
    ["a statement timeout", { data: null, error: { message: "canceling statement due to statement timeout" } }, "the signed slip: canceling statement due to statement timeout"],
  ])("the check answered with %s: refused, nothing stored or removed", async (_, answer, why) => {
    const { session } = setup({ slipReads: [answer] });
    const r = await sign();
    expect(r).toEqual({ error: `Could not check whether this viewing is already signed — nothing was changed: ${why}`, savedAt: null });
    expect(state.storage).toEqual([]);
    expect(session.argsOf("viewing_slips", "insert")).toHaveLength(0);
  });

  it("already signed: refused, nothing stored or removed", async () => {
    setup({ slipReads: [{ data: [{ id: "slip-0", signature_sha256: "x" }], error: null }] });
    const r = await sign();
    expect(r).toEqual({ error: "This viewing already has a signed slip.", savedAt: null });
    expect(state.storage).toEqual([]);
  });

  it("the organisation could not be read: refused before anything is stored — no slip saying 'Agency'", async () => {
    setup({ org: { data: null, error: null } });
    const r = await sign();
    expect(r).toEqual({ error: "Could not read your organisation — nothing was changed. Try again.", savedAt: null });
    expect(state.storage).toEqual([]);
  });

  it("the PNG path is taken by files a live attempt may still own: 'in progress', nothing removed", async () => {
    setup();
    state.pngTaken = true;
    state.listed = [{ name: `${VIEWING_ID}.png`, created_at: minutesAgo(1) }];
    const r = await sign();
    expect(r.error).toBe(IN_PROGRESS);
    expect(removals()).toEqual([]);
  });

  it("a live attempt's PNG beside a dead attempt's PDF: still 'in progress' — ANY young file is a claim", async () => {
    setup();
    state.pngTaken = true;
    state.listed = [
      { name: `${VIEWING_ID}.png`, created_at: minutesAgo(1) },
      { name: `${VIEWING_ID}.pdf`, created_at: minutesAgo(30) },
    ];
    const r = await sign();
    expect(r.error).toBe(IN_PROGRESS);
    expect(removals()).toEqual([]);
  });

  it("a file whose age cannot be read is treated as live", async () => {
    setup();
    state.pngTaken = true;
    state.listed = [{ name: `${VIEWING_ID}.png`, created_at: "not a date" }];
    expect((await sign()).error).toBe(IN_PROGRESS);
    expect(removals()).toEqual([]);
  });

  it("the taken path's listing fails: refused, nothing removed", async () => {
    setup();
    state.pngTaken = true;
    state.listFails = true;
    expect((await sign()).error).toBe("Could not check this viewing's slip files — nothing was changed. Try again.");
    expect(removals()).toEqual([]);
  });

  it("stale files, but the re-read before clearing fails: refused, nothing removed", async () => {
    setup({ slipReads: [NONE, { data: null, error: null, status: 200 } as FakePage] });
    state.pngTaken = true;
    state.listed = [{ name: `${VIEWING_ID}.png`, created_at: minutesAgo(30) }];
    const r = await sign();
    expect(r.error).toBe(
      "Could not check whether this viewing is already signed — nothing was changed: the signed slip: the answer held no rows (HTTP 200)",
    );
    expect(removals()).toEqual([]);
  });

  it("stale files whose removal fails: never 'cleared'", async () => {
    setup({ slipReads: [NONE, NONE] });
    state.pngTaken = true;
    state.removeFails = true;
    state.listed = [{ name: `${VIEWING_ID}.png`, created_at: minutesAgo(30) }];
    const r = await sign();
    expect(r.error).toBe("Could not clear the files an unfinished signing left — try again in a few minutes: storage unavailable");
  });

  it("a PNG upload error that is not 409: returned as it is — nothing listed, nothing removed", async () => {
    setup();
    state.pngError = { message: "upload failed: 503" };
    expect((await sign()).error).toBe("upload failed: 503");
    expect(ops()).toEqual([`upload:${PNG}`]);
  });

  it("a PDF already at its path (a dead attempt's, or a late write): taken out, uploaded once more — never overwritten", async () => {
    setup();
    state.pdfTaken = 1;
    const r = await sign();
    expect(r.error).toBeNull();
    expect(ops()).toEqual([`upload:${PNG}`, `upload:${PDF}`, `remove:${PDF}`, `upload:${PDF}`]);
    expect(state.storage.filter((s) => s.op === "upload").map((s) => s.upsert)).toEqual([false, false, false]);
  });

  it("the PDF path taken again on the second try: this attempt's PNG is taken back, the error returned", async () => {
    setup();
    state.pdfTaken = 2;
    const r = await sign();
    expect(r.error).toBe("The resource already exists");
    expect(ops().at(-1)).toBe(`remove:${PNG}`);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("the PNG path is taken by STALE files and the viewing is unsigned: exactly those are cleared, then 'sign again'", async () => {
    setup({ slipReads: [NONE, NONE] });
    state.pngTaken = true;
    state.listed = [
      { name: `${VIEWING_ID}.png`, created_at: minutesAgo(30) },
      { name: `${VIEWING_ID}.pdf`, created_at: minutesAgo(30) },
      { name: `${VIEWING_ID}-other.png`, created_at: minutesAgo(30) },
    ];
    const r = await sign();
    expect(r.error).toBe("An earlier signing that did not finish had left files behind; they have been cleared. Please sign again.");
    expect(removals()).toEqual([{ op: "remove", paths: [PNG, PDF] }]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("the PNG path was taken but its files are gone by the time they are listed: refused, nothing uploaded or removed", async () => {
    const { session } = setup();
    state.pngTaken = true;
    state.listed = [];
    const r = await sign();
    expect(r).toEqual({ error: "This viewing's slip files changed while signing — reload the page and try again.", savedAt: null });
    expect(ops()).toEqual([`upload:${PNG}`, `list:org-1`]);
    expect(session.argsOf("viewing_slips", "insert")).toHaveLength(0);
  });

  it("stale files but the viewing was signed meanwhile: 'already signed', nothing removed", async () => {
    setup({ slipReads: [NONE, { data: [{ id: "slip-0", signature_sha256: "x" }], error: null }] });
    state.pngTaken = true;
    state.listed = [{ name: `${VIEWING_ID}.png`, created_at: minutesAgo(30) }];
    const r = await sign();
    expect(r.error).toBe("This viewing already has a signed slip.");
    expect(removals()).toEqual([]);
  });

  it("an insert whose answer was lost, re-read as this attempt's own row: recorded, nothing removed", async () => {
    setup({ slipReads: [NONE, { data: [{ id: "slip-1", signature_sha256: SHA }], error: null }], insert: { data: null, error: null } });
    const r = await sign();
    expect(r.error).toBeNull();
    expect(removals()).toEqual([]);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("an insert answered with a falsy error, re-read as absent: NOT a success — and nothing removed (it may still land)", async () => {
    setup({ slipReads: [NONE, NONE], insert: { data: null, error: 0, status: 500 } as unknown as FakePage });
    const r = await sign();
    expect(r).toEqual({ error: "The slip may not have been saved (HTTP 500) — reload the viewing in a few minutes before signing again.", savedAt: null });
    expect(removals()).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a code-less transport failure (a reset), re-read as absent: nothing removed — PostgREST may still commit it", async () => {
    setup({ slipReads: [NONE, NONE], insert: { data: null, error: { message: "TypeError: fetch failed", code: "" }, status: 0 } as unknown as FakePage });
    const r = await sign();
    expect(r.error).toBe("The slip may not have been saved (HTTP 0) — reload the viewing in a few minutes before signing again.");
    expect(removals()).toEqual([]);
  });

  it("a 504 after the insert committed (a truthy, code-less error), re-read as this attempt's row: recorded, nothing removed", async () => {
    setup({
      slipReads: [NONE, { data: [{ id: "slip-1", signature_sha256: SHA }], error: null }],
      insert: { data: null, error: { message: "", code: "" }, status: 504 } as unknown as FakePage,
    });
    const r = await sign();
    expect(r.error).toBeNull();
    expect(removals()).toEqual([]);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("a refusal the database gave (a SQLSTATE), re-read as absent: the uploads are taken back", async () => {
    setup({ slipReads: [NONE, NONE], insert: { data: null, error: { message: "new row violates row-level security policy", code: "42501" } } });
    const r = await sign();
    expect(r.error).toBe("new row violates row-level security policy");
    expect(ops().at(-1)).toBe(`remove:${PNG},${PDF}`);
  });

  it("an insert answered with no rows ([]): not taken as saved — re-read as this attempt's row, recorded", async () => {
    setup({ slipReads: [NONE, { data: [{ id: "slip-1", signature_sha256: SHA }], error: null }], insert: { data: [], error: null } });
    const r = await sign();
    expect(r.error).toBeNull();
    expect(removals()).toEqual([]);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("an insert whose answer was lost, and the re-read fails too: nothing removed, the user told to reload", async () => {
    setup({ slipReads: [NONE, { data: null, error: null, status: 200 } as FakePage], insert: { data: null, error: null } });
    const r = await sign();
    expect(r.error).toBe(
      "Could not confirm whether the slip was saved — reload the viewing before signing again: the signed slip: the answer held no rows (HTTP 200)",
    );
    expect(removals()).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("an insert whose answer was lost, re-read as ANOTHER attempt's row: 'already signed', nothing removed", async () => {
    setup({ slipReads: [NONE, { data: [{ id: "slip-9", signature_sha256: "someone-else" }], error: null }], insert: { data: null, error: null } });
    const r = await sign();
    expect(r.error).toBe("This viewing already has a signed slip.");
    expect(removals()).toEqual([]);
  });
});
