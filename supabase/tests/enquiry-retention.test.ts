/**
 * The privacy page's two-year promise, kept by a job (0092, audit DATA-01).
 *
 * gnk-web/app/legal says an enquiry that does not lead to work is deleted
 * within two years. Until 0092 nothing performed that: a website lead with no
 * linked contact could only be redacted by hand. `redact_stale_enquiries()`
 * runs at 03:10 and redacts `leads.message` — the one column a website
 * enquiry's personal data lives in — for website leads with no contact, not
 * converted, older than 24 months, writing one `redacted` event per row with
 * no actor. This file is what fails when the sweep stops keeping the promise,
 * or keeps it against the wrong rows.
 *
 * Requires the local Supabase stack. Run: npm run test:rls
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonClient, ORG_A, ensureTestOrg, serviceClient } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);
const REDACTED = "[erased at the contact's request]"; // lib/services/erasure.ts LEAD_MESSAGE_REDACTED
const MONTHS = 24; // the number the site's legal page states — a matched pair

const agoMonths = (m: number) => new Date(Date.now() - m * 30.5 * 86_400_000).toISOString();
const body = (tag: string) => `Website enquiry\nName: Probe ${tag} ${run}\nEmail: ${tag}-${run}@example.invalid\n\nHello`;

const ids: Record<string, string> = {};
let contactId: string;

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");

  const { data: contact, error: cErr } = await svc
    .from("contacts")
    .insert({ org_id: ORG_A, contact_kind: "person", first_name: "Retention", last_name: run })
    .select("id")
    .single();
  if (cErr) throw new Error(`seed contact: ${cErr.message}`);
  contactId = contact.id;

  const rows: Array<[string, Record<string, unknown>]> = [
    // the one the sweep is for
    ["due", { source: "website", status: "new", received_at: agoMonths(MONTHS + 1) }],
    // one month short of the period — untouched tonight, due next month
    ["young", { source: "website", status: "new", received_at: agoMonths(MONTHS - 1) }],
    // linked to a contact: the contact's erasure owns it, not this sweep
    ["linked", { source: "website", status: "lost", received_at: agoMonths(MONTHS + 1), contact_id: contactId }],
    // converted: it became a deal; the AML basis decides its life
    ["converted", { source: "website", status: "converted", received_at: agoMonths(MONTHS + 1) }],
    // not from the website: typed by the desk about a person they know
    ["desk", { source: "phone", status: "new", received_at: agoMonths(MONTHS + 1) }],
  ];
  for (const [tag, extra] of rows) {
    const { data, error } = await svc
      .from("leads")
      .insert({ org_id: ORG_A, channel: "email", message: body(tag), ...extra })
      .select("id")
      .single();
    if (error) throw new Error(`seed lead ${tag}: ${error.message}`);
    ids[tag] = data.id;
  }
});

afterAll(async () => {
  await svc.from("leads").delete().in("id", Object.values(ids));
  await svc.from("contacts").delete().eq("id", contactId);
});

describe("redact_stale_enquiries", () => {
  it("redacts exactly the website enquiry that is old, unlinked and unconverted", async () => {
    const { data: count, error } = await svc.rpc("redact_stale_enquiries");
    expect(error).toBeNull();
    // at least ours; residue from other runs may add to the count locally
    expect(Number(count)).toBeGreaterThanOrEqual(1);

    const { data: leads } = await svc
      .from("leads")
      .select("id, message, criteria")
      .in("id", Object.values(ids));
    const byId = new Map((leads ?? []).map((l) => [l.id, l]));

    expect(byId.get(ids.due!)?.message).toBe(REDACTED);
    for (const tag of ["young", "linked", "converted", "desk"]) {
      expect(byId.get(ids[tag]!)?.message, `${tag} must be untouched`).toBe(body(tag));
    }
    // criteria is shape only (a listing reference at most) and stays
    expect(byId.get(ids.due!)?.criteria).not.toBeNull();
  });

  it("writes one `redacted` event with no actor and a shape-only payload for the row it redacted", async () => {
    const { data: events } = await svc
      .from("events")
      .select("event_type, actor_id, payload")
      .eq("entity_type", "lead")
      .eq("entity_id", ids.due!)
      .eq("event_type", "redacted");
    expect(events).toHaveLength(1);
    expect(events![0]!.actor_id).toBeNull();
    expect(events![0]!.payload).toEqual({ reason: "retention", months: MONTHS });

    const { data: none } = await svc
      .from("events")
      .select("id")
      .eq("entity_type", "lead")
      .eq("event_type", "redacted")
      .in("entity_id", [ids.young!, ids.linked!, ids.converted!, ids.desk!]);
    expect(none ?? []).toHaveLength(0);
  });

  it("is idempotent: a second run redacts nothing of ours and writes no second event", async () => {
    await svc.rpc("redact_stale_enquiries");
    const { data: events } = await svc
      .from("events")
      .select("id")
      .eq("entity_type", "lead")
      .eq("entity_id", ids.due!)
      .eq("event_type", "redacted");
    expect(events).toHaveLength(1);
  });

  it("refuses a nonsense period rather than redacting everything", async () => {
    // The 24-month default itself is asserted where it is declared: the
    // migration's self-check reads pg_get_functiondef at apply time.
    const { error } = await svc.rpc("redact_stale_enquiries", { p_months: 0 });
    expect(error, "p_months = 0 must be refused").not.toBeNull();
  });

  it("is service-only: anon cannot call it", async () => {
    const { error } = await anonClient().rpc("redact_stale_enquiries");
    expect(error).not.toBeNull();
  });
});

describe("submit_public_enquiry derives the channel (0092, DATA-02)", () => {
  const made: string[] = [];
  afterAll(async () => {
    if (made.length) await svc.from("leads").delete().in("id", made);
  });

  async function submit(email: string, phone: string) {
    const { data: ok, error } = await svc.rpc("submit_public_enquiry", {
      p_org_slug: "test-org-a",
      p_name: `Channel probe ${run}`,
      p_email: email,
      p_phone: phone,
      p_message: `channel probe ${run} ${email || phone}`,
      p_property_ref: "",
    });
    expect(error).toBeNull();
    expect(ok).toBe(true);
    const { data } = await svc
      .from("leads")
      .select("id, channel")
      .eq("org_id", ORG_A)
      .eq("source", "website")
      .like("message", `%channel probe ${run} ${email || phone}%`)
      .order("received_at", { ascending: false })
      .limit(1)
      .single();
    made.push(data!.id);
    return data!.channel as string;
  }

  it("files a phone-only enquiry as a call", async () => {
    expect(await submit("", "+357 99 000000")).toBe("phone");
  });

  it("files an enquiry with an email as email, even when a phone is given too", async () => {
    expect(await submit(`probe-${run}@example.invalid`, "+357 99 000000")).toBe("email");
  });
});
