import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";
import { slipObjectPath } from "@/lib/services/slip-paths";

/**
 * The two service-role readers of the private `signatures` bucket fetch the
 * object named by the slip ROW's ids, never the row's stored path.
 *
 * `viewing_slips.signature_path` / `pdf_path` are free text a session may
 * INSERT, and the readers use the admin client, which no storage policy
 * limits. Reproduced on the local stack (T-deal-child-org-isolation's review,
 * rolled back): organisation B's admin inserted a slip on B's own viewing
 * naming `<A org>/<A viewing>.pdf`; `getSlipDownloadUrl` then signed A's PDF,
 * and the evidence pack embedded A's signature PNG. The row's org_id is the
 * caller's (RLS), so the derived name is the caller's own object.
 */

const state = vi.hoisted(() => ({
  client: null as unknown,
  signed: [] as string[],
  downloaded: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-b", orgId: ORG_B, role: "admin", fullName: "B. Admin" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminClient(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// the PDF renderer is heavy and not under test here
vi.mock("@/lib/services/slip-pdf", () => ({ renderSlipPdf: async () => Buffer.from("%PDF-1.4 fake") }));

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const VIEWING_A = "a1a1a1a1-0000-4000-8000-0000000000a1";
const VIEWING_B = "b2b2b2b2-0000-4000-8000-0000000000b2";
const CONTACT = "c3c3c3c3-0000-4000-8000-0000000000c3";

const { getSlipDownloadUrl } = await import("@/lib/actions/viewing-slips");
const { assembleEvidence } = await import("@/lib/services/evidence");

/** what the admin client was asked for, in the bucket it was asked of */
function adminClient() {
  return {
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string) => {
          state.signed.push(`${bucket}:${path}`);
          return { data: { signedUrl: `https://signed.example/${path}` }, error: null };
        },
        download: async (path: string) => {
          state.downloaded.push(`${bucket}:${path}`);
          return { data: { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer }, error: null };
        },
      }),
    },
  };
}

/** B's own slip row, planted with A's file names */
const planted = {
  org_id: ORG_B,
  viewing_id: VIEWING_B,
  signer_name: "Planted",
  signed_at: "2026-09-20T10:00:00Z",
  signature_sha256: "0".repeat(64),
  signature_path: slipObjectPath(ORG_A, VIEWING_A, "png"),
  pdf_path: slipObjectPath(ORG_A, VIEWING_A, "pdf"),
};

describe("getSlipDownloadUrl", () => {
  it("signs the slip row's own object, not the path the row stores", async () => {
    state.client = fakeClient({ viewing_slips: [{ data: planted, error: null }] }).client;
    state.signed = [];
    const res = await getSlipDownloadUrl(VIEWING_B);
    expect(res.error).toBeNull();
    expect(state.signed).toEqual([`signatures:${ORG_B}/${VIEWING_B}.pdf`]);
    expect(res.url).not.toContain(ORG_A);
  });

  it("signs nothing when the row records no PDF", async () => {
    state.client = fakeClient({ viewing_slips: [{ data: { ...planted, pdf_path: null }, error: null }] }).client;
    state.signed = [];
    const res = await getSlipDownloadUrl(VIEWING_B);
    expect(res).toEqual({ url: null, error: "No slip found" });
    expect(state.signed).toEqual([]);
  });
});

describe("the commission evidence pack", () => {
  it("embeds the slip row's own signature image, not the path the row stores", async () => {
    const caller = fakeClient({
      contacts: [{ data: { id: CONTACT, display_name: "Fixture Buyer", phone_e164: null, email: null }, error: null }],
      organizations: [{ data: { name: "Fixture Agency" }, error: null }],
      deals: [{ data: [], error: null }],
      viewings: [{ data: [{ id: VIEWING_B, property_id: null }], error: null }],
      viewing_slips: [{ data: [planted], error: null }],
    });
    state.downloaded = [];
    const out = await assembleEvidence(caller.client as never, adminClient() as never, ORG_B, {
      contactId: CONTACT,
      withSlipImages: true,
      generatedBy: { name: "B. Admin", role: "admin" },
    });
    expect("errorKey" in out, JSON.stringify(out)).toBe(false);
    expect(state.downloaded).toEqual([`signatures:${ORG_B}/${VIEWING_B}.png`]);
    const slips = (out as { slips: { viewingId: string; pngDataUri: string | null }[] }).slips;
    expect(slips).toHaveLength(1);
    expect(slips[0]!.pngDataUri).toMatch(/^data:image\/png;base64,/);
  });
});

describe("signViewingSlip writes the same names the readers derive", () => {
  it("one definition: <org>/<viewing>.png and .pdf", () => {
    expect(slipObjectPath(ORG_B, VIEWING_B, "png")).toBe(`${ORG_B}/${VIEWING_B}.png`);
    expect(slipObjectPath(ORG_B, VIEWING_B, "pdf")).toBe(`${ORG_B}/${VIEWING_B}.pdf`);
  });
});
