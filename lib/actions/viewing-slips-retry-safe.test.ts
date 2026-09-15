import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * Signing a slip is three writes to two systems — PNG to Storage, PDF to
 * Storage, a row to the database — and it used to do them in the one order
 * that could not be retried (integrations audit 2026-09-15, INT-08): the PNG
 * went up FIRST with `upsert: false`, then the PDF was rendered and uploaded,
 * then the row inserted. A PDF that failed to render or upload left the PNG
 * in Storage with no row, and the agent's second attempt was refused by
 * Storage ("already exists") for as long as the object lived — a viewing that
 * could never be signed until an administrator deleted the file by hand.
 *
 * What is pinned here: the order (render in memory before anything is
 * stored; strand nothing on a render failure), that a fresh signing first
 * removes whatever an earlier attempt stranded at its own paths, and that a
 * failure after an upload takes the uploads back out.
 */
const state = vi.hoisted(() => ({
  client: null as unknown,
  storage: [] as Array<{ op: "upload" | "remove"; paths: string[] }>,
  failPdfUpload: false,
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
    storage: {
      from: () => ({
        upload: async (path: string) => {
          state.storage.push({ op: "upload", paths: [path] });
          if (state.failPdfUpload && path.endsWith(".pdf")) {
            return { data: null, error: { message: "upload failed: 503" } };
          }
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          state.storage.push({ op: "remove", paths });
          return { data: [], error: null };
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

const viewing = {
  id: VIEWING_ID,
  org_id: "org-1",
  agent_id: "actor-1",
  scheduled_at: "2026-09-15T10:00:00.000Z",
  status: "scheduled",
  properties: { reference: "PAF0001", address: null },
  agent: { full_name: "A. Agent" },
};

function setup(insert: FakePage) {
  state.storage = [];
  state.failPdfUpload = false;
  state.renderThrows = false;
  logEvent.mockClear();
  const fake = fakeClient({
    viewings: [{ data: viewing, error: null }],
    // the "already signed?" read, then the insert
    viewing_slips: [{ data: null, error: null }, insert],
    organizations: [{ data: { name: "Test Agency" }, error: null }],
  });
  state.client = fake.client;
  return fake;
}

function form(): FormData {
  const fd = new FormData();
  fd.set("viewing_id", VIEWING_ID);
  fd.set("signer_name", "A Buyer");
  fd.set("signature_data", `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`);
  return fd;
}

const ops = () => state.storage.map((s) => `${s.op}:${s.paths.join(",")}`);

describe("signing a slip is retry-safe", () => {
  it("renders the PDF before anything is stored: a render failure strands nothing", async () => {
    setup({ data: null, error: null });
    state.renderThrows = true;
    const r = await signViewingSlip({ error: null, savedAt: null }, form());
    expect(r.error).toContain("Could not render slip PDF");
    expect(state.storage, "no upload and no removal happened").toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("removes what an earlier attempt stranded at its paths, then uploads PNG and PDF, then inserts", async () => {
    const fake = setup({ data: null, error: null });
    const r = await signViewingSlip({ error: null, savedAt: null }, form());
    expect(r.error).toBeNull();
    expect(ops()).toEqual([`remove:${PNG},${PDF}`, `upload:${PNG}`, `upload:${PDF}`]);
    expect(fake.argsOf("viewing_slips", "insert")).toHaveLength(1);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("a failed PDF upload takes the PNG back out", async () => {
    const fake = setup({ data: null, error: null });
    state.failPdfUpload = true;
    const r = await signViewingSlip({ error: null, savedAt: null }, form());
    expect(r.error).toContain("upload failed");
    expect(ops().at(-1)).toBe(`remove:${PNG}`);
    expect(fake.argsOf("viewing_slips", "insert")).toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a failed row insert takes both objects back out", async () => {
    setup({ data: null, error: { message: "connection reset", code: "XX000" } });
    const r = await signViewingSlip({ error: null, savedAt: null }, form());
    expect(r.error).toBe("connection reset");
    expect(ops().at(-1)).toBe(`remove:${PNG},${PDF}`);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a slip signed by someone else in between is reported as such, and its uploads are taken back out", async () => {
    setup({ data: null, error: { message: "duplicate key", code: "23505" } });
    const r = await signViewingSlip({ error: null, savedAt: null }, form());
    expect(r.error).toBe("This viewing already has a signed slip.");
    expect(ops().at(-1)).toBe(`remove:${PNG},${PDF}`);
  });
});
