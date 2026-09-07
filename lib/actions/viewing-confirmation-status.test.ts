import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * Which viewings may have a confirmation issued.
 *
 * There was no status check at all, so a CANCELLED viewing would produce a PDF
 * telling the attendee where to be and when — a document false on its face,
 * addressed to a client, carrying the agency's name. The same went for one
 * already completed or marked no-show.
 *
 * `tests/e2e/viewing-confirmation.spec.ts` covers the happy path thoroughly
 * (it even checks the digest against the chained event) and could not catch
 * this: its viewing is scheduled, as every viewing in the suite is.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);
const renderPdf = vi.hoisted(() =>
  vi.fn<() => Promise<Buffer>>(async () => Buffer.from("%PDF-1.4 fake")),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/services/viewing-confirmation-pdf", () => ({
  renderViewingConfirmationPdf: renderPdf,
}));

const { generateViewingConfirmation } = await import("@/lib/actions/viewing-documents");

const viewing = (status: string) => ({
  id: "v1",
  org_id: "org-1",
  agent_id: "actor-1",
  scheduled_at: new Date(Date.UTC(2027, 0, 6, 10, 0)).toISOString(),
  duration_min: 30,
  status,
  properties: { reference: "PAF0001", address: "Peyia" },
  contacts: { display_name: "A Buyer" },
  agent: { full_name: "An Agent", email: null, phone_e164: null },
});

function setup(pages: FakePage[]) {
  const fake = fakeClient({ viewings: pages });
  state.client = fake.client;
  logEvent.mockClear();
  renderPdf.mockClear();
  return fake;
}

const form = () => {
  const fd = new FormData();
  fd.set("viewing_id", "v1");
  return fd;
};

describe("generateViewingConfirmation refuses a viewing with nothing to confirm", () => {
  it.each(["cancelled", "completed", "no_show"])("refuses a %s viewing", async (status) => {
    setup([{ data: viewing(status), error: null }]);
    const res = await generateViewingConfirmation({ error: null, savedAt: null, documentId: null }, form());
    expect(res.error, "and says which status it is").toMatch(new RegExp(status));
    expect(
      renderPdf,
      "no PDF is rendered — the refusal comes before any work",
    ).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });
});
