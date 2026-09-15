import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG_A, ensureTestOrg, serviceClient } from "./helpers";

/**
 * 0096: the enquiry door is idempotent by key, and hands the lead back
 * (integrations audit 2026-09-15, INT-02 and INT-01).
 *
 * The site gives the CRM eight seconds and the function commits in under one;
 * when the site gives up after the row has committed, the visitor sees a
 * failure, the desk sees a lead, and the visitor's second attempt used to
 * make a second lead. A key the site mints per form makes the second attempt
 * answer with the first lead and write nothing — no row, no event, and (in
 * the route) no second desk alert.
 *
 * The return shape changed with it: `returns boolean` became one row of
 * (lead_id, lead_org_id, replayed), and a refusal is ZERO rows. The route
 * needs the id to record the alert's outcome on the lead's timeline.
 */
const svc = serviceClient();
const run = Date.now().toString(36);
const made: string[] = [];

const base = {
  p_org_slug: "test-org-a",
  p_name: `Idem ${run}`,
  p_email: "idem@example.invalid",
  p_phone: "",
  p_message: `idempotency probe ${run}`,
  p_property_ref: "",
};

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
});

afterAll(async () => {
  if (made.length) await svc.from("leads").delete().in("id", made);
});

describe("submit_public_enquiry with an idempotency key (0096)", () => {
  it("returns the lead it made, and the same lead again for the same key, writing once", async () => {
    const key = `k-${run}-aaaaaaaa`;
    const first = await svc.rpc("submit_public_enquiry", { ...base, p_idempotency_key: key });
    expect(first.error).toBeNull();
    const row = first.data![0]!;
    expect(row.replayed, "the first post is not a replay").toBe(false);
    expect(row.lead_org_id).toBe(ORG_A);
    made.push(row.lead_id);

    const again = await svc.rpc("submit_public_enquiry", { ...base, p_idempotency_key: key });
    expect(again.error).toBeNull();
    expect(again.data![0]).toEqual({ lead_id: row.lead_id, lead_org_id: ORG_A, replayed: true });

    const { count: leads } = await svc
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ORG_A)
      .eq("idempotency_key", key);
    expect(leads, "one lead for one key").toBe(1);

    const { count: created } = await svc
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", row.lead_id)
      .eq("event_type", "created");
    expect(created, "one created event for one key — the replay wrote nothing").toBe(1);
  });

  it("no key means no dedup: two keyless posts are two leads", async () => {
    const a = await svc.rpc("submit_public_enquiry", { ...base, p_idempotency_key: "" });
    const b = await svc.rpc("submit_public_enquiry", { ...base, p_idempotency_key: "" });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const idA = a.data![0]!.lead_id;
    const idB = b.data![0]!.lead_id;
    made.push(idA, idB);
    expect(idA).not.toBe(idB);
  });

  it("refuses a key of the wrong shape as it refuses any bad input: zero rows, nothing written", async () => {
    const bad = await svc.rpc("submit_public_enquiry", {
      ...base,
      p_idempotency_key: "no spaces allowed!",
    });
    expect(bad.error).toBeNull();
    expect(bad.data).toEqual([]);
  });

  it("a refusal of the enquiry itself is still zero rows, not a false", async () => {
    const noReply = await svc.rpc("submit_public_enquiry", {
      ...base,
      p_email: "",
      p_phone: "",
      p_idempotency_key: `k-${run}-noreply`,
    });
    expect(noReply.error).toBeNull();
    expect(noReply.data).toEqual([]);
  });
});
