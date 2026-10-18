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

const { readEntityTimeline, readEntityTimelines, compareNewestFirst, CUSTOMER_FEED_SKIPPED_TYPES, idSlices, IDS_PER_READ } =
  await import("./entity-timeline");

// the VIEWER's client — a blank fake; see event-context.test.ts for what it is asked
const viewer = () => fakeClient({}).client as never;

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
      limit: 50, viewerRole: "admin", viewer: viewer(),
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
      limit: 50, viewerRole: "admin", viewer: viewer(),
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
    expect(await readEntityTimeline({ orgId: "org-1", entityType: "key", entityIds: [], limit: 20, viewerRole: "admin", viewer: viewer() }))
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
      await readEntityTimeline({ orgId: "", entityType: "contact", entityIds: ["c1"], limit: 50, viewerRole: "admin", viewer: viewer() }),
    ).toEqual([]);
    expect(svc.served.events ?? 0, "no query at all").toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("newest first, ties broken by chain order, and capped", async () => {
    const svc = fakeClient({ events: [{ data: [], error: null }] });
    admin.client = svc.client;
    await readEntityTimeline({ orgId: "o", entityType: "deal", entityIds: ["d1"], limit: 50, viewerRole: "admin", viewer: viewer() });
    // a close writes won_override and won in ONE transaction, so they share
    // occurred_at (0117); within an org, id order is chain order (0109)
    expect(svc.argsOf("events", "order")).toEqual([
      ["occurred_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    // one past the cap: that row's presence is what says older events exist
    expect(svc.argsOf("events", "limit")).toEqual([[51]]);
  });

  it("returns at most `limit` rows even though it asks for one more", async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ ...row(4 - i, "updated") }));
    const svc = fakeClient({ events: [{ data: many, error: null }] });
    admin.client = svc.client;
    const rows = await readEntityTimeline({ orgId: "o", entityType: "contact", entityIds: ["c1"], limit: 3, viewerRole: "admin", viewer: viewer() });
    expect(rows.map((r) => r.id), "the probe row is never shown").toEqual([4, 3, 2]);
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
      await readEntityTimeline({ orgId: "o", entityType: "contact", entityIds: ["c1"], limit: 50, viewerRole: "admin", viewer: viewer() }),
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
  /*
   * Mirrors what the upload actions actually write: `visibility` read back from
   * the inserted ROW, alongside doc_type. The KYC mapping here is
   * contactDocVisibility's, which is what contact-documents.ts inserts — the
   * fixture is not free to invent a combination production cannot produce, and
   * `evidence_report` below is a combination it CAN.
   */
  const KYC = ["id_document", "proof_of_address", "source_of_funds"];
  const docEvent = (
    doc_type: string,
    title = "passport_AB123456.pdf",
    visibility = KYC.includes(doc_type) ? "admin_only" : "internal",
  ) => ({
    id: 1,
    occurred_at: "2026-09-07T10:00:00Z",
    event_type: "document_uploaded",
    entity_type: "contact",
    entity_id: "c1",
    payload: { document_id: "d1", title, doc_type, visibility },
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
      viewer: viewer(),
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

  /*
   * THE SHAPE PRODUCTION ACTUALLY WROTE, which the case above did not use.
   *
   * Until 2026-09-08 neither delete path put `doc_type` in the payload —
   * `deleteContactDocument` and `deletePropertyDocument` both wrote
   * `{ document_id, title }` — so the doc_type branch was DEAD for every
   * `document_deleted` and the redactor was unconditionally strip-the-title for
   * anyone who was not an admin. The test above passed on a payload the writers
   * never produced, which is why it did not notice: it asserted the right answer
   * for the wrong reason. Both writers now carry doc_type; these two cases pin
   * both shapes so neither half can regress alone.
   */
  it("still withholds a deletion written before the payload carried doc_type", async () => {
    const [row] = await read("agent", [
      {
        id: 9,
        occurred_at: "2026-09-07T10:00:00Z",
        event_type: "document_deleted",
        entity_type: "contact",
        entity_id: "c1",
        payload: { document_id: "d1", title: "passport_AB123456.pdf" },
      },
    ]);
    expect(
      (row.payload as Record<string, unknown>).title,
      "nothing left in the row can say what it was — withheld forever, correctly",
    ).toBeUndefined();
  });

  it("gives back the name of a deleted document agents could read while it existed", async () => {
    const [row] = await read("agent", [
      {
        id: 10,
        occurred_at: "2026-09-08T10:00:00Z",
        event_type: "document_deleted",
        entity_type: "property",
        entity_id: "p1",
        payload: {
          document_id: "d2",
          title: "Title deed PAF0001.pdf",
          doc_type: "title_deed",
          visibility: "internal",
        },
      },
    ]);
    expect(
      (row.payload as Record<string, unknown>).title,
      "an org-readable document loses nothing by being deleted",
    ).toBe("Title deed PAF0001.pdf");
  });

  it("and still withholds a deleted KYC document's name", async () => {
    const [row] = await read("agent", [
      {
        id: 11,
        occurred_at: "2026-09-08T10:00:00Z",
        event_type: "document_deleted",
        entity_type: "contact",
        entity_id: "c1",
        payload: {
          document_id: "d3",
          title: "passport.pdf",
          doc_type: "id_document",
          visibility: "admin_only",
        },
      },
    ]);
    expect((row.payload as Record<string, unknown>).title).toBeUndefined();
  });

  /*
   * THE CASE THAT BROKE THE doc_type INFERENCE.
   *
   * `lib/actions/reports.ts` inserts a commission evidence report as
   * `doc_type: 'evidence_report'` with `visibility: 'admin_only'` when an admin
   * generates it. `evidence_report` is not a KYC type, so the old rule —
   * `contactDocVisibility(doc_type) === 'internal'` — called it internal and
   * showed the title, which reads "Commission evidence — <contact> — <date>",
   * to every agent. `documents_select` admits only an admin to that row.
   *
   * The 0072 CHECK that the old docstring cited forbids a KYC contact row from
   * being anything but admin_only. It says nothing about the other direction,
   * which is the direction that mattered.
   */
  it("withholds an admin-only report's title even though its doc_type is not KYC", async () => {
    const [row] = await read("agent", [
      docEvent("evidence_report", "Commission evidence — Maria Georgiou — 2026-09-08", "admin_only"),
    ]);
    expect(
      (row.payload as Record<string, unknown>).title,
      "documents_select admits only an admin to this row",
    ).toBeUndefined();
  });

  it("still shows it to an admin, who may open the report", async () => {
    const [row] = await read("admin", [
      docEvent("evidence_report", "Commission evidence — Maria Georgiou — 2026-09-08", "admin_only"),
    ]);
    expect((row.payload as Record<string, unknown>).title).toBe(
      "Commission evidence — Maria Georgiou — 2026-09-08",
    );
  });

  it("fails CLOSED on a payload with no visibility at all", async () => {
    // Every document event written before 2026-09-08. Measured on production:
    // three document_deleted rows in this shape, zero document_uploaded.
    const ev = docEvent("title_deed", "Title deed PAF0001.pdf");
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ev.payload as Record<string, unknown>)) {
      if (k !== "visibility") payload[k] = v;
    }
    const [row] = await read("agent", [{ ...ev, payload }]);
    expect(
      (row.payload as Record<string, unknown>).title,
      "an org-readable doc_type is not proof the ROW was org-readable",
    ).toBeUndefined();
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
      viewer: viewer(),
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

  /*
   * `listing_status_check` HAS TWO RAISERS AND ONLY ONE NAMES A DEAL.
   *
   * markDealWon writes `{kind, task_id, deal_id}` — "the deal was won but the
   * listing still reads on-market", a deals_select fact, withheld. Converting a
   * hold writes `{kind, task_id, reservation_id}` — "the reservation converted to
   * a sale…", and `reservations_select` is plain `org_id = current_org_id()` with
   * no role arm (measured against the live policy). The same action also writes an
   * unredacted `reservation_status_changed` that prints "Reservation held →
   * converted" one line above it, so withholding the second sentence protected
   * nothing and cost the desk the only line saying why the follow-up exists.
   */
  it("keeps the reservation-raised check for an agent — reservations_select is org-wide", async () => {
    const [row] = await read("agent", [
      {
        ...followup("listing_status_check"),
        payload: { kind: "listing_status_check", task_id: "t1", reservation_id: "r1" },
      },
    ]);
    const payload = row.payload as Record<string, unknown>;
    expect(payload.kind, "no deal is named, and the sale is already on the page").toBe(
      "listing_status_check",
    );
    expect(payload.reservation_id).toBe("r1");
  });

  it("still withholds reservation_still_live, which carries a deal id as well", async () => {
    // raiseLiveHoldCheck writes BOTH ids, so `reservation_id` is not the
    // discriminator — `deal_id` is, and this kind always names a won deal.
    const [row] = await read("agent", [
      {
        ...followup("reservation_still_live"),
        payload: {
          kind: "reservation_still_live",
          task_id: "t1",
          deal_id: "d1",
          reservation_id: "r1",
        },
      },
    ]);
    const payload = row.payload as Record<string, unknown>;
    expect(payload.kind).toBeUndefined();
    expect(payload.deal_id).toBeUndefined();
    expect(payload.reservation_id, "the hold itself is not the secret").toBe("r1");
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

describe("a task's or document's title comes from its ROW, read as the VIEWER (T-event-typed-text-shape)", () => {
  /*
   * The events are read as the system — which events exist is a fact about the
   * record. What a document is CALLED is not: `documents_select` withholds an
   * admin_only row from agents, so the title must be asked for on the caller's
   * own client, where RLS answers. Asking the admin client would hand a passport
   * scan's name to every agent through the timeline.
   */
  const DOC = "55555555-5555-4555-8555-555555555555";
  const uploaded = {
    id: 9,
    occurred_at: "2026-09-24T10:00:00Z",
    event_type: "document_uploaded",
    entity_type: "contact",
    entity_id: "c1",
    payload: { document_id: DOC, doc_type: "contract", visibility: "internal" },
  };

  it("asks the viewer's client for the title, and the system's client for the events only", async () => {
    const svc = fakeClient({ events: [{ data: [uploaded], error: null }] });
    admin.client = svc.client;
    const mine = fakeClient({ documents: [{ data: [{ id: DOC, title: "Sale agreement.pdf" }], error: null }] });

    const [row] = await readEntityTimeline({
      orgId: "org-1",
      entityType: "contact",
      entityIds: ["c1"],
      limit: 50,
      viewerRole: "agent",
      viewer: mine.client as never,
    });

    expect(row.current_title).toBe("Sale agreement.pdf");
    expect(svc.calls.filter((c) => c.table === "documents"), "never the admin client").toEqual([]);
    expect(mine.argsOf("documents", "in")).toEqual([["id", [DOC]]]);
    expect(mine.argsOf("documents", "eq")).toEqual([["org_id", "org-1"]]);
  });

  it("a row the viewer cannot read (RLS returns nothing) leaves the line neutral", async () => {
    const svc = fakeClient({ events: [{ data: [uploaded], error: null }] });
    admin.client = svc.client;
    const mine = fakeClient({ documents: [{ data: [], error: null }] });
    const [row] = await readEntityTimeline({
      orgId: "org-1",
      entityType: "contact",
      entityIds: ["c1"],
      limit: 50,
      viewerRole: "agent",
      viewer: mine.client as never,
    });
    expect(row.current_title).toBeUndefined();
    expect(row.event_type).toBe("document_uploaded");
  });
});

describe("the reader names the author (A06)", () => {
  it("selects actor_id, so a feed can say who did it", async () => {
    const svc = fakeClient({ events: [{ data: [], error: null }] });
    admin.client = svc.client;
    await readEntityTimeline({ orgId: "o", entityType: "contact", entityIds: ["c1"], limit: 50, viewerRole: "admin", viewer: viewer() });
    const [[columns]] = svc.argsOf("events", "select") as [[string]];
    expect(columns.split(",").map((c) => c.trim())).toContain("actor_id");
  });

  it("an answer with no rows array is a failed read, logged — not a record nothing happened to", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = fakeClient({ events: [{ data: null, error: null }] });
    admin.client = svc.client;
    expect(
      await readEntityTimeline({ orgId: "o", entityType: "lead", entityIds: ["l1"], limit: 50, viewerRole: "admin", viewer: viewer() }),
    ).toEqual([]);
    expect(err).toHaveBeenCalledWith("timeline read failed:", expect.objectContaining({ entityType: "lead" }));
    err.mockRestore();
  });
});

describe("a signed slip's names are withheld from everyone but an admin (A06)", () => {
  /*
   * `viewing_slip_signed` sits on the VIEWING, and `viewings_select` is
   * org-wide — so once a contact's feed reads its viewings' events, every
   * agent and listing manager who opens the contact would read the signer's
   * name and the second attendee's. `viewing_slips_select` admits only an
   * admin or the viewing's own agent.
   */
  const slip = (payload: Record<string, unknown>) => ({
    id: 21,
    occurred_at: "2026-10-01T10:00:00Z",
    event_type: "viewing_slip_signed",
    entity_type: "viewing",
    entity_id: "v1",
    actor_id: "agent-1",
    payload,
  });
  const NAMES = { sha256: "a".repeat(64), pdf_sha256: "b".repeat(64), signer_name: "Zenobia Quillfeather", second_attendee: "Q. Quillfeather", geotagged: true };

  const read = async (viewerRole: string, payload: Record<string, unknown> = NAMES) => {
    const svc = fakeClient({ events: [{ data: [slip(payload)], error: null }] });
    admin.client = svc.client;
    const [r] = await readEntityTimeline({ orgId: "o", entityType: "viewing", entityIds: ["v1"], limit: 50, viewerRole, viewer: viewer() });
    return r.payload as Record<string, unknown>;
  };

  it.each(["agent", "listing_manager"])("strips both names for a %s, keeping the digests", async (role) => {
    const p = await read(role);
    expect(p.signer_name).toBeUndefined();
    expect(p.second_attendee).toBeUndefined();
    expect(p.sha256, "the integrity facts stay").toBe("a".repeat(64));
    expect(p.geotagged).toBe(true);
  });

  it("keeps them for an admin, who may open the slip", async () => {
    const p = await read("admin");
    expect(p.signer_name).toBe("Zenobia Quillfeather");
    expect(p.second_attendee).toBe("Q. Quillfeather");
  });

  it("strips a name from a crafted slip event on another record too — the rule is the TYPE", async () => {
    const svc = fakeClient({ events: [{ data: [{ ...slip(NAMES), entity_type: "contact", entity_id: "c1" }], error: null }] });
    admin.client = svc.client;
    const [r] = await readEntityTimeline({ orgId: "o", entityType: "contact", entityIds: ["c1"], limit: 50, viewerRole: "agent", viewer: viewer() });
    expect(JSON.stringify(r.payload)).not.toContain("Quillfeather");
  });

  it("goes through the combined reader as well", async () => {
    const svc = fakeClient({ events: [{ data: [slip(NAMES)], error: null }] });
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "o",
      viewerRole: "agent",
      viewer: viewer(),
      sources: [{ entityType: "viewing", entityIds: ["v1"] }],
      perSource: 50,
      limit: 100,
    });
    expect(JSON.stringify(out.rows)).not.toContain("Quillfeather");
  });
});

describe("readEntityTimelines — one feed from several records (A06)", () => {
  const ev = (id: number, at: string, entity_type: string, event_type = "updated", actor_id: string | null = "p1") => ({
    id,
    occurred_at: at,
    event_type,
    entity_type,
    entity_id: `${entity_type}-1`,
    actor_id,
    payload: {},
  });

  it("reads each source with its own org filter, merges newest first, and breaks a tie by chain order", async () => {
    const svc = fakeClient({
      events: [
        { data: [ev(5, "2026-10-03T10:00:00Z", "contact"), ev(1, "2026-10-01T10:00:00Z", "contact")], error: null },
        // a lead event in the SAME instant as the contact's newest: id decides (chain order)
        { data: [ev(7, "2026-10-03T10:00:00Z", "lead", "called"), ev(2, "2026-10-02T10:00:00Z", "lead", "contacted")], error: null },
      ],
    });
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "agent",
      viewer: fakeClient({ profiles: [{ data: [{ id: "p1", full_name: "Agent One" }], error: null }] }).client as never,
      sources: [
        { entityType: "contact", entityIds: ["contact-1"] },
        { entityType: "lead", entityIds: ["lead-1"] },
      ],
      perSource: 50,
      limit: 100,
    });
    expect(out.rows.map((r) => r.id)).toEqual([7, 5, 2, 1]);
    expect(out.incomplete).toBe(false);
    expect(out.truncated).toBe(false);
    const eqs = svc.argsOf("events", "eq");
    expect(eqs.filter(([k]) => k === "org_id"), "one org boundary PER source").toEqual([
      ["org_id", "org-1"],
      ["org_id", "org-1"],
    ]);
    expect(eqs.filter(([k]) => k === "entity_type")).toEqual([
      ["entity_type", "contact"],
      ["entity_type", "lead"],
    ]);
  });

  it("asks nothing for a source with no ids", async () => {
    const svc = fakeClient({ events: [{ data: [], error: null }] });
    admin.client = svc.client;
    await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "admin",
      viewer: viewer(),
      sources: [
        { entityType: "contact", entityIds: ["c1"] },
        { entityType: "lead", entityIds: [] },
        { entityType: "deal", entityIds: [] },
      ],
      perSource: 50,
      limit: 100,
    });
    expect(svc.served.events, "one query: the contact").toBe(1);
  });

  it("leaves the skipped types out IN THE QUERY, so telemetry cannot fill a source's cap", async () => {
    const svc = fakeClient({ events: [{ data: [], error: null }] });
    admin.client = svc.client;
    await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "admin",
      viewer: viewer(),
      sources: [{ entityType: "lead", entityIds: ["l1"] }],
      perSource: 50,
      limit: 100,
      excludeEventTypes: CUSTOMER_FEED_SKIPPED_TYPES,
    });
    expect(svc.argsOf("events", "not")).toEqual([["event_type", "in", "(enquiry_alert,lead_escalation)"]]);
  });

  it("says the history is INCOMPLETE when one source fails, and still shows the others", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = fakeClient({
      events: [
        { data: [ev(3, "2026-10-03T10:00:00Z", "contact")], error: null },
        { data: null, error: { message: "statement timeout" } },
      ],
    });
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "admin",
      viewer: viewer(),
      sources: [
        { entityType: "contact", entityIds: ["c1"] },
        { entityType: "deal", entityIds: ["d1"] },
      ],
      perSource: 50,
      limit: 100,
    });
    expect(out.incomplete, "a failed source is said, never a shorter history").toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual([3]);
    err.mockRestore();
  });

  it("drops rows older than a capped source's edge — they would sit where its missing lines belong", async () => {
    // the lead source holds MORE than 2 (the probe row, 7, came back): anything
    // older than its oldest kept row may have siblings it never returned
    const svc = fakeClient({
      events: [
        {
          data: [ev(9, "2026-10-09T10:00:00Z", "lead"), ev(8, "2026-10-08T10:00:00Z", "lead"), ev(7, "2026-10-07T10:00:00Z", "lead")],
          error: null,
        },
        { data: [ev(4, "2026-10-08T12:00:00Z", "contact"), ev(1, "2025-01-01T10:00:00Z", "contact")], error: null },
      ],
    });
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "admin",
      viewer: viewer(),
      sources: [
        { entityType: "lead", entityIds: ["l1"] },
        { entityType: "contact", entityIds: ["c1"] },
      ],
      perSource: 2,
      limit: 100,
    });
    expect(out.rows.map((r) => r.id), "the year-old contact line waits behind the cap").toEqual([9, 4, 8]);
    expect(out.truncated).toBe(true);
    expect(svc.argsOf("events", "limit"), "each source asks one past perSource").toEqual([[3], [3]]);
  });

  it("a source with EXACTLY perSource events is complete: no floor, nothing dropped, not truncated (A06 review)", async () => {
    // the lead source answered 2 of the 3 asked for — it has no third event,
    // so the contact's year-old line is real history, not a gap's neighbour
    const svc = fakeClient({
      events: [
        { data: [ev(9, "2026-10-09T10:00:00Z", "lead"), ev(8, "2026-10-08T10:00:00Z", "lead")], error: null },
        { data: [ev(4, "2026-10-08T12:00:00Z", "contact"), ev(1, "2025-01-01T10:00:00Z", "contact")], error: null },
      ],
    });
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "admin",
      viewer: viewer(),
      sources: [
        { entityType: "lead", entityIds: ["l1"] },
        { entityType: "contact", entityIds: ["c1"] },
      ],
      perSource: 2,
      limit: 100,
    });
    expect(out.rows.map((r) => r.id)).toEqual([9, 4, 8, 1]);
    expect(out.truncated, "nothing was missing").toBe(false);
  });

  it("sends a long id list in slices under the 414, and merges them as one source", async () => {
    // a developer: the seller on 250 unit deals
    const ids = Array.from({ length: 250 }, (_, i) => `d${String(i).padStart(3, "0")}`);
    const svc = fakeClient({
      events: [
        { data: [ev(2, "2026-10-02T10:00:00Z", "deal")], error: null },
        { data: [], error: null },
        // the NEWEST event is on a deal in the last slice — once past the 50th id, never asked about
        { data: [ev(9, "2026-10-09T10:00:00Z", "deal", "conversation_logged")], error: null },
      ],
    });
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "admin",
      viewer: viewer(),
      sources: [{ entityType: "deal", entityIds: ids }],
      perSource: 50,
      limit: 100,
    });
    const slices = svc.argsOf("events", "in").map(([, v]) => v as string[]);
    expect(slices.map((v) => v.length)).toEqual([100, 100, 50]);
    expect(slices.flat(), "every id asked about, once").toEqual(ids);
    expect(svc.argsOf("events", "eq").filter(([k]) => k === "org_id").length, "each slice org-bound").toBe(3);
    expect(out.rows.map((r) => r.id)).toEqual([9, 2]);
    expect(out.incomplete).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it("caps a sliced source over the UNION: two slices of 2 rows each, perSource 3 → capped at the third newest", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `d${i}`);
    const svc = fakeClient({
      events: [
        { data: [ev(8, "2026-10-08T10:00:00Z", "deal"), ev(4, "2026-10-04T10:00:00Z", "deal")], error: null },
        { data: [ev(6, "2026-10-06T10:00:00Z", "deal"), ev(2, "2026-10-02T10:00:00Z", "deal")], error: null },
        { data: [ev(5, "2026-10-05T12:00:00Z", "contact"), ev(1, "2025-01-01T10:00:00Z", "contact")], error: null },
      ],
    });
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "admin",
      viewer: viewer(),
      sources: [
        { entityType: "deal", entityIds: ids },
        { entityType: "contact", entityIds: ["c1"] },
      ],
      perSource: 3,
      limit: 100,
    });
    // the deal source holds 4 > 3: it keeps 8, 6, 4 and its floor is 4, so
    // the contact's year-old line waits; the contact's 5 is above the floor
    expect(out.rows.map((r) => r.id)).toEqual([8, 6, 5, 4]);
    expect(out.truncated).toBe(true);
  });

  it("one failed slice fails its whole source — half a source is not its history", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ids = Array.from({ length: 101 }, (_, i) => `d${i}`);
    const svc = fakeClient({
      events: [
        { data: [ev(8, "2026-10-08T10:00:00Z", "deal")], error: null },
        { data: null, error: { message: "URI too long" } },
        { data: [ev(3, "2026-10-03T10:00:00Z", "contact")], error: null },
      ],
    });
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "admin",
      viewer: viewer(),
      sources: [
        { entityType: "deal", entityIds: ids },
        { entityType: "contact", entityIds: ["c1"] },
      ],
      perSource: 50,
      limit: 100,
    });
    expect(out.incomplete).toBe(true);
    expect(out.rows.map((r) => r.id), "the deal slice that answered is not shown as the deals' history").toEqual([3]);
    err.mockRestore();
  });

  it("cuts the merge at `limit` and says so", async () => {
    const svc = fakeClient({
      events: [
        { data: [ev(3, "2026-10-03T10:00:00Z", "contact"), ev(1, "2026-10-01T10:00:00Z", "contact")], error: null },
        { data: [ev(2, "2026-10-02T10:00:00Z", "deal")], error: null },
      ],
    });
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "admin",
      viewer: viewer(),
      sources: [
        { entityType: "contact", entityIds: ["c1"] },
        { entityType: "deal", entityIds: ["d1"] },
      ],
      perSource: 50,
      limit: 2,
    });
    expect(out.rows.map((r) => r.id)).toEqual([3, 2]);
    expect(out.truncated).toBe(true);
  });

  it("names the authors from profiles on the VIEWER's client; the system stays null", async () => {
    const svc = fakeClient({
      events: [{ data: [ev(2, "2026-10-02T10:00:00Z", "contact", "updated", "p1"), ev(1, "2026-10-01T10:00:00Z", "contact", "superseded", null)], error: null }],
    });
    admin.client = svc.client;
    const mine = fakeClient({ profiles: [{ data: [{ id: "p1", full_name: "Agent One" }], error: null }] });
    const out = await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "agent",
      viewer: mine.client as never,
      sources: [{ entityType: "contact", entityIds: ["c1"] }],
      perSource: 50,
      limit: 100,
    });
    expect(out.rows.map((r) => [r.actor_id, r.actor_name])).toEqual([
      ["p1", "Agent One"],
      [null, null],
    ]);
    expect(mine.argsOf("profiles", "in")).toEqual([["id", ["p1"]]]);
    expect(mine.argsOf("profiles", "eq")).toEqual([["org_id", "org-1"]]);
    expect(svc.calls.filter((c) => c.table === "profiles"), "never the admin client").toEqual([]);
  });

  it("a failed author read leaves the names off — a person never becomes the system", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = fakeClient({ events: [{ data: [ev(2, "2026-10-02T10:00:00Z", "contact", "updated", "p1")], error: null }] });
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "org-1",
      viewerRole: "agent",
      viewer: fakeClient({ profiles: [{ data: null, error: { message: "boom" } }] }).client as never,
      sources: [{ entityType: "contact", entityIds: ["c1"] }],
      perSource: 50,
      limit: 100,
    });
    expect(out.rows[0].actor_id).toBe("p1");
    expect(out.rows[0].actor_name).toBeNull();
    err.mockRestore();
  });

  it("refuses a missing org: nothing is asked, and the feed says it is incomplete", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = fakeClient({});
    admin.client = svc.client;
    const out = await readEntityTimelines({
      orgId: "",
      viewerRole: "admin",
      viewer: viewer(),
      sources: [{ entityType: "contact", entityIds: ["c1"] }],
      perSource: 50,
      limit: 100,
    });
    expect(svc.served.events ?? 0).toBe(0);
    expect(out).toEqual({ rows: [], incomplete: true, truncated: false });
    err.mockRestore();
  });
});

describe("idSlices", () => {
  it("slices at IDS_PER_READ, keeps the order, drops repeats, and makes nothing of an empty list", () => {
    expect(IDS_PER_READ, "under the gateway's ~197-id 414").toBeLessThan(197);
    const ids = Array.from({ length: 205 }, (_, i) => `x${i}`);
    expect(idSlices(ids).map((s) => s.length)).toEqual([100, 100, 5]);
    expect(idSlices(ids).flat()).toEqual(ids);
    expect(idSlices(["a", "b", "a", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(idSlices([])).toEqual([]);
  });
});

describe("compareNewestFirst", () => {
  it("orders by instant, then by chain id", () => {
    const rows = [
      { id: 1, occurred_at: "2026-10-01T10:00:00+00:00" },
      { id: 3, occurred_at: "2026-10-01T10:00:00.5+00:00" },
      { id: 2, occurred_at: "2026-10-01T10:00:00.5+00:00" },
      { id: 4, occurred_at: "2026-10-02T09:00:00+00:00" },
    ];
    expect([...rows].sort(compareNewestFirst).map((r) => r.id)).toEqual([4, 3, 2, 1]);
  });

  it("compares the sub-millisecond digits Date.parse drops", () => {
    const a = { id: 1, occurred_at: "2026-10-01T10:00:00.123456+00:00" };
    const b = { id: 2, occurred_at: "2026-10-01T10:00:00.123+00:00" };
    expect(compareNewestFirst(a, b), "the later microsecond is the newer, whatever the id").toBeLessThan(0);
  });
});
