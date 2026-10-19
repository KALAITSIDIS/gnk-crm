import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * A proposal bound to a buyer (A04) refuses a recipient that may not receive
 * one — before any link is minted — and a listing that was archived after the
 * match row was drawn. Until A04 no screen sent `contact_id`; the match rows
 * now do, so the lifecycle check is no longer theoretical.
 *
 * The organisation half of the recipient check (a contact the caller cannot
 * see, a read that failed) is pinned in contact-link-reread.test.ts and is
 * unchanged.
 */

const logEvent = vi.hoisted(() => vi.fn(async () => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "agent" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { createShareLink, createAvailabilityLink } = await import("@/lib/actions/share-links");

const CONTACT = "c0c0c0c0-1111-4111-8111-111111111111";
const P1 = "a0a0a0a0-1111-4111-8111-111111111111";
const P2 = "a0a0a0a0-2222-4222-8222-222222222222";
const LINK = "b0b0b0b0-1111-4111-8111-111111111111";

const visible = (...rows: { id: string; visibility?: string }[]): FakePage => ({ data: rows, error: null });
const recipient = (over: Record<string, unknown> = {}): FakePage => ({
  data: { id: CONTACT, is_archived: false, erased_at: null, ...over },
  error: null,
});

function use(pages: Record<string, FakePage[]>) {
  const fake = fakeClient(pages);
  state.client = fake.client;
  return fake;
}

beforeEach(() => {
  logEvent.mockClear();
  revalidatePath.mockClear();
});

describe("createShareLink — the buyer it is bound to", () => {
  it("refuses an ERASED contact, and mints nothing", async () => {
    const fake = use({
      properties: [visible({ id: P1, visibility: "private" })],
      contacts: [recipient({ is_archived: true, erased_at: "2026-10-01T00:00:00Z" })],
    });
    const res = await createShareLink({ property_ids: [P1], contact_id: CONTACT });
    expect(res).toEqual({
      error: "This contact was erased — no proposal can be made for them.",
      path: null,
      savedAt: null,
      notice: null,
    });
    expect(fake.argsOf("share_links", "insert")).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("refuses an ARCHIVED contact, and mints nothing", async () => {
    const fake = use({ properties: [visible({ id: P1 })], contacts: [recipient({ is_archived: true })] });
    const res = await createShareLink({ property_ids: [P1], contact_id: CONTACT });
    expect(res.error).toBe("This contact is archived — restore it before sending them a proposal.");
    expect(fake.argsOf("share_links", "insert")).toEqual([]);
  });

  it("reads the recipient's lifecycle with the same single read by id", async () => {
    const fake = use({ properties: [visible({ id: P1 })], contacts: [recipient()], share_links: [{ data: null, error: { message: "stop here" } }] });
    await createShareLink({ property_ids: [P1], contact_id: CONTACT });
    expect(fake.argsOf("contacts", "select")).toEqual([["id, is_archived, erased_at"]]);
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
  });

  it("a proposal with no recipient reads no contact at all (the /share-links pool)", async () => {
    const fake = use({ properties: [visible({ id: P1 })], share_links: [{ data: null, error: { message: "stop here" } }] });
    await createShareLink({ property_ids: [P1] });
    expect(fake.argsOf("contacts", "select")).toEqual([]);
  });

  it("refuses a listing archived since the row was drawn — the proposal page would drop it", async () => {
    const fake = use({
      properties: [visible({ id: P1, visibility: "private" }, { id: P2, visibility: "archived" })],
      contacts: [recipient()],
    });
    const res = await createShareLink({ property_ids: [P1, P2], contact_id: CONTACT });
    expect(res.error).toMatch(/archived meanwhile/i);
    expect(fake.argsOf("share_links", "insert")).toEqual([]);
  });

  it("an off-market listing is the desk's judgement, not a refusal — the action mints it", async () => {
    const fake = use({
      properties: [visible({ id: P1, visibility: "off_market" })],
      contacts: [recipient()],
      share_links: [{ data: { id: LINK }, error: null, status: 201 }],
      share_link_properties: [{ data: null, error: null, status: 201 }],
    });
    const res = await createShareLink({ property_ids: [P1], contact_id: CONTACT, locale: "ru" });
    expect(res.error).toBeNull();
    expect(res.path).toMatch(/^\/p\/[A-Za-z0-9_-]{43}$/);
    expect(fake.argsOf("share_links", "insert")[0]?.[0]).toMatchObject({ contact_id: CONTACT, locale: "ru", kind: "proposal" });
    // the buyer's page and the listing's page now say "Proposed"
    expect(revalidatePath).toHaveBeenCalledWith(`/contacts/${CONTACT}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/properties/${P1}`);
  });

  it("more than 25 listings is refused by the schema before any read", async () => {
    const fake = use({});
    const ids = Array.from({ length: 26 }, (_, i) => `a0a0a0a0-1111-4111-8111-${String(i).padStart(12, "0")}`);
    const res = await createShareLink({ property_ids: ids, contact_id: CONTACT });
    expect(res.error).toMatch(/25 properties at most/);
    expect(fake.calls).toEqual([]);
  });
});

describe("createAvailabilityLink — the same recipient rule", () => {
  it("refuses an erased or archived contact", async () => {
    for (const over of [{ is_archived: true, erased_at: "2026-10-01T00:00:00Z" }, { is_archived: true }]) {
      const fake = use({
        properties: [{ data: { id: P1, kind: "project", reference: "PAF0001" }, error: null }],
        contacts: [recipient(over)],
      });
      const res = await createAvailabilityLink({ project_id: P1, contact_id: CONTACT });
      expect(res.error).toMatch(/erased|archived/);
      expect(fake.argsOf("share_links", "insert")).toEqual([]);
    }
  });
});
