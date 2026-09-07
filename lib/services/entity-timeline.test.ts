import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";

/**
 * The timeline reader. Its whole reason for existing is WHICH client it asks:
 * `events_select` (0063) shows a non-admin only the rows they authored, so on
 * the caller's client "what happened to this record" silently becomes "what did
 * I do to this record" — and every system event, whose actor_id is null,
 * disappears for everyone but an admin.
 *
 * Because it reads as the system, the org filter is the only boundary left, and
 * it is therefore the thing most worth pinning.
 */

const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.client }));

const { readEntityTimeline } = await import("./entity-timeline");

const row = (id: number, event_type: string) => ({
  id,
  occurred_at: `2026-09-0${id}T10:00:00Z`,
  event_type,
  entity_type: "contact",
  entity_id: "c1",
  payload: {},
});

describe("readEntityTimeline", () => {
  it("asks the SYSTEM, so a colleague's event and a cron's event both appear", async () => {
    const svc = fakeClient({
      events: [{ data: [row(1, "created"), row(2, "updated"), row(3, "superseded")], error: null }],
    });
    admin.client = svc.client;

    const rows = await readEntityTimeline({
      orgId: "org-1",
      entityType: "contact",
      entityIds: ["c1"],
      limit: 50, viewerRole: "admin",
    });
    expect(
      rows.map((r) => r.event_type),
      "measured on the real database: the caller's own client returns 1 of these 3",
    ).toEqual(["created", "updated", "superseded"]);
  });

  it("filters org_id explicitly — the only boundary the admin client has", async () => {
    const svc = fakeClient({ events: [{ data: [], error: null }] });
    admin.client = svc.client;
    await readEntityTimeline({
      orgId: "org-1",
      entityType: "contact",
      entityIds: ["c1", "c2"],
      limit: 50, viewerRole: "admin",
    });
    expect(svc.argsOf("events", "eq")).toEqual(
      expect.arrayContaining([
        ["org_id", "org-1"],
        ["entity_type", "contact"],
      ]),
    );
    expect(svc.argsOf("events", "in")).toEqual([["entity_id", ["c1", "c2"]]]);
  });

  it("asks nothing at all when there are no ids", async () => {
    // Not an optimisation: `in("entity_id", [])` on a service-role client is a
    // query with no entity predicate left, and the habit of sending one is how
    // a missing filter becomes a whole-org read.
    const svc = fakeClient({});
    admin.client = svc.client;
    expect(await readEntityTimeline({ orgId: "org-1", entityType: "key", entityIds: [], limit: 20, viewerRole: "admin" }))
      .toEqual([]);
    expect(svc.served.events ?? 0).toBe(0);
  });

  it("refuses a missing org rather than querying without a boundary", async () => {
    // On a service-role client org_id is the ONLY boundary. A caller deriving
    // it from an empty list would pass "" and never notice.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = fakeClient({});
    admin.client = svc.client;
    expect(
      await readEntityTimeline({ orgId: "", entityType: "contact", entityIds: ["c1"], limit: 50, viewerRole: "admin" }),
    ).toEqual([]);
    expect(svc.served.events ?? 0, "no query at all").toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("newest first, and capped", async () => {
    const svc = fakeClient({ events: [{ data: [], error: null }] });
    admin.client = svc.client;
    await readEntityTimeline({ orgId: "o", entityType: "deal", entityIds: ["d1"], limit: 50, viewerRole: "admin" });
    expect(svc.argsOf("events", "order")).toEqual([["occurred_at", { ascending: false }]]);
    expect(svc.argsOf("events", "limit")).toEqual([[50]]);
  });

  it("a failed read is LOGGED — the screen still cannot tell it from an empty history", async () => {
    /*
     * Stated exactly, because an earlier name here claimed more than the code
     * does: on failure this returns [] and the page renders "nothing has
     * happened yet", which is indistinguishable from the truth. What it also
     * does is say so in the server log, so the silence is discoverable.
     *
     * Throwing instead would replace a record's page with an error boundary
     * over a read that is not the reason anyone opened it. That is the trade,
     * and it is deliberate — not a property this test should overstate.
     */
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = fakeClient({ events: [{ data: null, error: { message: "statement timeout" } }] });
    admin.client = svc.client;

    expect(
      await readEntityTimeline({ orgId: "o", entityType: "contact", entityIds: ["c1"], limit: 50, viewerRole: "admin" }),
    ).toEqual([]);
    expect(err).toHaveBeenCalledWith(
      "timeline read failed:",
      expect.objectContaining({ entityType: "contact", error: "statement timeout" }),
    );
    err.mockRestore();
  });
});

describe("document titles: the one thing this reader must not hand over", () => {
  /*
   * `documents_select` is `admin OR visibility = 'internal'`, so an agent or
   * listing manager cannot read an `admin_only` document row at all — those are
   * the CDD records (passport, proof of address, source of funds) that
   * lib/validators/documents.ts calls "the most sensitive PII the desk holds",
   * "enforced three deep".
   *
   * The upload files its event on the CONTACT, whose timeline this reader
   * returns org-wide, and the payload carries the title — which defaults to the
   * uploaded FILE NAME. Reading the whole history without redacting would put
   * "Document uploaded — passport_AB123456.pdf" on every agent's screen and
   * undo all three layers.
   */
  const docEvent = (doc_type: string, title = "passport_AB123456.pdf") => ({
    id: 1,
    occurred_at: "2026-09-07T10:00:00Z",
    event_type: "document_uploaded",
    entity_type: "contact",
    entity_id: "c1",
    payload: { document_id: "d1", title, doc_type },
  });

  const read = async (viewerRole: string, rows: unknown[]) => {
    const svc = fakeClient({ events: [{ data: rows, error: null }] });
    admin.client = svc.client;
    return readEntityTimeline({
      orgId: "org-1",
      entityType: "contact",
      entityIds: ["c1"],
      limit: 50,
      viewerRole,
    });
  };

  it.each(["id_document", "proof_of_address", "source_of_funds"])(
    "withholds the file name of a %s from an agent",
    async (docType) => {
      const [row] = await read("agent", [docEvent(docType)]);
      expect(
        (row.payload as Record<string, unknown>).title,
        "the renderer falls back to an untitled line, so the event still shows",
      ).toBeUndefined();
      expect(row.event_type, "the event itself is not hidden — only its name").toBe(
        "document_uploaded",
      );
    },
  );

  it("withholds it from a listing manager too — the policy admits only admins", async () => {
    const [row] = await read("listing_manager", [docEvent("id_document")]);
    expect((row.payload as Record<string, unknown>).title).toBeUndefined();
  });

  it("shows an ordinary internal document's title, which agents may already read", async () => {
    const [row] = await read("agent", [docEvent("contract", "Sale agreement.pdf")]);
    expect((row.payload as Record<string, unknown>).title).toBe("Sale agreement.pdf");
  });

  it("shows everything to an admin, who can read the document row anyway", async () => {
    const [row] = await read("admin", [docEvent("id_document")]);
    expect((row.payload as Record<string, unknown>).title).toBe("passport_AB123456.pdf");
  });

  it("fails CLOSED on a payload with no doc_type", async () => {
    // A shape this reader does not recognise must lose the name, not keep it.
    const ev = docEvent("id_document");
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ev.payload as Record<string, unknown>)) {
      if (k !== "doc_type") payload[k] = v;
    }
    const [row] = await read("agent", [{ ...ev, payload }]);
    expect((row.payload as Record<string, unknown>).title).toBeUndefined();
  });

  it("redacts document_deleted too, where the row is already gone", async () => {
    const ev = { ...docEvent("source_of_funds"), event_type: "document_deleted" };
    const [row] = await read("agent", [ev]);
    expect((row.payload as Record<string, unknown>).title).toBeUndefined();
  });

  it("leaves every other event's payload untouched", async () => {
    const [row] = await read("agent", [
      {
        id: 2,
        occurred_at: "2026-09-07T10:00:00Z",
        event_type: "price_changed",
        entity_type: "property",
        entity_id: "p1",
        payload: { title: "not a document", from: 1, to: 2 },
      },
    ]);
    expect((row.payload as Record<string, unknown>).title).toBe("not a document");
  });
});

describe("a won deal is not announced to agents who may not read it", () => {
  /*
   * `properties_select` is org-wide; `deals_select` is not. A `listing_status_check`
   * event is raised ONLY while the property still reads available/reserved/
   * under_offer, so the property row does not betray the sale — and the task's
   * own title is hidden by tasks_select. Rendering the kind would tell every
   * agent that a colleague's deal closed on that listing.
   */
  const followup = (kind: string) => ({
    id: 1,
    occurred_at: "2026-09-07T10:00:00Z",
    event_type: "followup_task_created",
    entity_type: "property",
    entity_id: "p1",
    payload: { kind, task_id: "t1", deal_id: "d1" },
  });

  const read = async (viewerRole: string, rows: unknown[]) => {
    const svc = fakeClient({ events: [{ data: rows, error: null }] });
    admin.client = svc.client;
    return readEntityTimeline({
      orgId: "org-1",
      entityType: "property",
      entityIds: ["p1"],
      limit: 50,
      viewerRole,
    });
  };

  it.each(["listing_status_check", "reservation_still_live"])(
    "withholds %s from an agent, leaving the neutral follow-up line",
    async (kind) => {
      const [row] = await read("agent", [followup(kind)]);
      const payload = row.payload as Record<string, unknown>;
      expect(payload.kind, "describeEvent falls back to 'Follow-up task created'").toBeUndefined();
      expect(payload.deal_id, "and the deal id goes with it").toBeUndefined();
      expect(row.event_type, "the event itself stays — a follow-up WAS raised").toBe(
        "followup_task_created",
      );
      expect(payload.task_id, "the rest of the payload is untouched").toBe("t1");
    },
  );

  it("keeps it for a listing manager, who may read every deal anyway", async () => {
    const [row] = await read("listing_manager", [followup("listing_status_check")]);
    expect((row.payload as Record<string, unknown>).kind).toBe("listing_status_check");
  });

  it("keeps it for an admin", async () => {
    const [row] = await read("admin", [followup("reservation_still_live")]);
    expect((row.payload as Record<string, unknown>).kind).toBe("reservation_still_live");
  });

  it("leaves follow-up kinds that reveal no deal alone", async () => {
    // viewing_no_show, retention_expired and the rest describe the record the
    // viewer is already looking at — withholding them would cost the desk
    // information for nothing.
    const [row] = await read("agent", [followup("viewing_no_show")]);
    expect((row.payload as Record<string, unknown>).kind).toBe("viewing_no_show");
  });

  it("leaves every other event type alone", async () => {
    const [row] = await read("agent", [
      { ...followup("listing_status_check"), event_type: "price_changed" },
    ]);
    expect((row.payload as Record<string, unknown>).kind).toBe("listing_status_check");
  });
});
