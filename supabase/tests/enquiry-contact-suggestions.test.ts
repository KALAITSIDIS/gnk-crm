import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import {
  loadEnquiryContactSuggestions,
  type EnquirySuggestionState,
} from "@/lib/queries/enquiry-contact-suggestions";
import { linkUnlinkedLead } from "@/lib/services/lead-contact-link";
import { TEST_PASSWORD, anonClient, createTestUser, serviceClient, type TestUser } from "./helpers";

/**
 * "Possible existing contact" against the real database and real sessions
 * (T-enquiry-contact-suggestions).
 *
 * The unit tests pin what the page lookup ASKS for and what the action does
 * with each answer. This file pins what comes BACK under RLS and
 * `require_aal2` — per organisation, per role, for a session without its
 * second factor, for archived and erased contacts — that the lookup writes
 * nothing, and that the conditional link holds when two real sessions race it.
 *
 * TWO THROWAWAY ORGANISATIONS, created and deleted as postgres (the
 * events-chain-order idiom): the fixtures are plain inserts (no events), and
 * the read-only check compares whole-organisation snapshots, which a shared
 * fixture organisation with other suites' residue could not give.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const svc = serviceClient();
const run = Date.now().toString(36);
const ORG_P = randomUUID(); // the caller's organisation
const ORG_Q = randomUUID(); // another agency with the SAME person on file
const typed = (c: SupabaseClient) => c as unknown as SupabaseClient<Database>;
let pg: Client;

let adminP: TestUser;
let agentP1: TestUser;
let agentP2: TestUser;
let managerP: TestUser;
let adminQ: TestUser;

const MARIA_EMAIL = `maria-${run}@example.invalid`;
const MARIA_PHONE = "+35799123456";
const OTHER_PHONE = "+35799000001"; // a different person's phone
const ADD_PRIMARY = "+35799000002";
const ADD_EXTRA = "+35799000003"; // parked in additional_phones
const ARCHIVED_EMAIL = `archived-${run}@example.invalid`;
const ERASED_EMAIL = `erased-${run}@example.invalid`;
const ERASED_UNARCHIVED_EMAIL = `erased-unarchived-${run}@example.invalid`;

const ids: Record<string, string> = {};
let propertyId: string;

const header = (email: string | null, phone: string | null) =>
  ["Website enquiry", "Name: Visitor", email ? `Email: ${email}` : null, phone ? `Phone: ${phone}` : null, "", "Hello"]
    .filter((l) => l !== null)
    .join("\n");

async function insertContact(key: string, row: Record<string, unknown>, org = ORG_P) {
  const { data, error } = await svc
    .from("contacts")
    .insert({ org_id: org, contact_kind: "person", ...row })
    .select("id")
    .single();
  if (error) throw new Error(`contact ${key}: ${error.message}`);
  ids[key] = data.id;
}

async function insertLead(key: string, row: Record<string, unknown>, org = ORG_P) {
  const { data, error } = await svc
    .from("leads")
    .insert({ org_id: org, source: "website", status: "new", ...row })
    .select("id")
    .single();
  if (error) throw new Error(`lead ${key}: ${error.message}`);
  ids[key] = data.id;
}

async function snapshot(org: string) {
  const leads = await pg.query(
    "select id, contact_id, status, assigned_agent_id, updated_at from leads where org_id = $1 order by id",
    [org],
  );
  const contacts = await pg.query("select id, updated_at, is_archived from contacts where org_id = $1 order by id", [org]);
  const events = await pg.query("select count(*)::int as n from events where org_id = $1", [org]);
  return { leads: leads.rows, contacts: contacts.rows, events: events.rows[0].n as number };
}

const enquiries = () => [
  { id: ids.eBoth!, message: header(MARIA_EMAIL.toUpperCase(), "0035799123456") },
  { id: ids.eSplit!, message: header(MARIA_EMAIL, "+357 99 000001") },
  { id: ids.eAdditional!, message: header(null, "99 000 003") },
  { id: ids.eArchived!, message: header(ARCHIVED_EMAIL, null) },
  { id: ids.eErased!, message: header(ERASED_EMAIL, null) },
  { id: ids.eErasedUnarchived!, message: header(ERASED_UNARCHIVED_EMAIL, null) },
  { id: ids.eNobody!, message: header(`nobody-${run}@example.invalid`, null) },
];

const matches = (s: EnquirySuggestionState | undefined) => {
  if (s?.status !== "matches") throw new Error(`expected matches, got ${s?.status}`);
  return s;
};

beforeAll(async () => {
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await pg.query("insert into organizations (id, name, slug) values ($1, $2, $3), ($4, $5, $6)", [
    ORG_P,
    `Suggestions ${run}`,
    `suggest-p-${run}`,
    ORG_Q,
    `Suggestions other ${run}`,
    `suggest-q-${run}`,
  ]);
  [adminP, agentP1, agentP2, managerP, adminQ] = await Promise.all([
    createTestUser(svc, `suggest-admin-p-${run}@test.local`, "admin", ORG_P),
    createTestUser(svc, `suggest-agent-p1-${run}@test.local`, "agent", ORG_P),
    createTestUser(svc, `suggest-agent-p2-${run}@test.local`, "agent", ORG_P),
    createTestUser(svc, `suggest-manager-p-${run}@test.local`, "listing_manager", ORG_P),
    createTestUser(svc, `suggest-admin-q-${run}@test.local`, "admin", ORG_Q),
  ]);

  const { data: prop, error: propErr } = await svc
    .from("properties")
    .insert({ org_id: ORG_P, reference: `SUG${run}`.slice(0, 20).toUpperCase(), property_type: "apartment", visibility: "private", status: "draft" })
    .select("id")
    .single();
  if (propErr) throw new Error(`property: ${propErr.message}`);
  propertyId = prop.id;

  // contacts — organisation P
  await insertContact("maria", { first_name: "Maria", last_name: "Georgiou", email: MARIA_EMAIL, phone_e164: MARIA_PHONE });
  await insertContact("phoneOnly", { first_name: "Maria", last_name: "Papa", phone_e164: OTHER_PHONE });
  await insertContact("additional", { first_name: "Andreas", last_name: "Extra", phone_e164: ADD_PRIMARY, additional_phones: [ADD_EXTRA] });
  await insertContact("archived", { first_name: "Old", last_name: "Archived", email: ARCHIVED_EMAIL, is_archived: true });
  await insertContact("erased", {
    first_name: "Gone",
    last_name: "Erased",
    email: ERASED_EMAIL,
    is_archived: true,
    erased_at: new Date().toISOString(),
  });
  // erased, then unarchived: unarchiveContact checks only is_archived and
  // merged_into_id, so this row is reachable — `erased_at` must be tested on its own
  await insertContact("erasedUnarchived", {
    first_name: "Gone",
    last_name: "Unarchived",
    email: ERASED_UNARCHIVED_EMAIL,
    is_archived: false,
    erased_at: new Date().toISOString(),
  });
  // the SAME person on file at another agency — must never cross over
  await insertContact("mariaQ", { first_name: "Maria", last_name: "AtQ", email: MARIA_EMAIL, phone_e164: MARIA_PHONE }, ORG_Q);

  // EVERY lead here is dated in 2099: the live `lead-sla` cron (every ten
  // minutes, every org) writes a task and an event for an open, unanswered
  // enquiry that is already due, and one landing between the read-only
  // snapshots would fail that test for nothing the lookup did (the
  // lead-escalation-preview idiom). Only their ORDER matters to the lookup.
  //
  // Maria's history in P: five linked enquiries, newest first h5..h1, one per agent/status shape
  const days = ["2099-05-01", "2099-06-01", "2099-07-01", "2099-08-01", "2099-09-01"];
  for (const [i, day] of days.entries()) {
    await insertLead(`h${i + 1}`, {
      contact_id: ids.maria,
      received_at: `${day}T09:00:00Z`,
      status: i === 4 ? "contacted" : "lost",
      assigned_agent_id: i === 4 ? agentP2.id : null,
      property_id: i === 4 ? propertyId : null,
      message: `history ${run} ${i + 1}`,
    });
  }
  await insertLead("hQ", { contact_id: ids.mariaQ, received_at: "2099-09-10T09:00:00Z", message: `other agency ${run}` }, ORG_Q);
  // another agency's lead pointing at P's contact — the foreign key names
  // contacts(id) alone, so this row can exist. NEWER than h5: if leads_select
  // ever stopped scoping the embedded history, Maria's list would change.
  await insertLead("foreignOnMaria", { contact_id: ids.maria, received_at: "2099-09-15T09:00:00Z", message: `foreign ${run}` }, ORG_Q);
  await insertLead("hArchived", { contact_id: ids.archived, received_at: "2099-04-01T09:00:00Z", message: `archived ${run}` });

  // the unlinked website enquiries on P's inbox
  for (const key of ["eBoth", "eSplit", "eAdditional", "eArchived", "eErased", "eErasedUnarchived", "eNobody"]) {
    await insertLead(key, { received_at: "2099-09-20T09:00:00Z", message: `placeholder ${run}` });
  }
  for (const e of enquiries()) {
    const { error } = await svc.from("leads").update({ message: e.message }).eq("id", e.id);
    if (error) throw new Error(`message: ${error.message}`);
  }
});

afterAll(async () => {
  // Leads first, for BOTH organisations: one points across them, and leads
  // hold the users (assigned_agent_id) and the contacts. Only then can the
  // auth users go — a delete that fails comes back as { error }, not a throw.
  const orgs = [ORG_P, ORG_Q];
  await pg.query("delete from notification_jobs where org_id = any($1)", [orgs]);
  await pg.query("delete from tasks where org_id = any($1)", [orgs]);
  await pg.query("delete from leads where org_id = any($1)", [orgs]);
  for (const u of [adminP, agentP1, agentP2, managerP, adminQ]) {
    if (!u) continue;
    const { error } = await svc.auth.admin.deleteUser(u.id);
    if (error) console.warn(`teardown: deleteUser ${u.email}: ${error.message}`);
  }
  for (const org of orgs) {
    await pg.query("delete from contacts where org_id = $1", [org]);
    await pg.query("delete from properties where org_id = $1", [org]);
    await pg.query("delete from profiles where org_id = $1", [org]);
    await pg.query("delete from events where org_id = $1", [org]);
    await pg.query("delete from events_chain_checkpoint where org_id = $1", [org]);
    await pg.query("delete from chain_checks where org_id = $1", [org]);
    await pg.query("delete from organizations where id = $1", [org]);
  }
  await pg.end();
});

describe("what the lookup returns under RLS", () => {
  it("matches the e-mail case-insensitively and the phone across formats, with the 3 most recent linked enquiries", async () => {
    const states = await loadEnquiryContactSuggestions(typed(adminP.client), enquiries());
    const both = matches(states.get(ids.eBoth!));
    expect(both.candidates.map((c) => [c.contact.id, c.matchedOn])).toEqual([[ids.maria, "email_and_phone"]]);
    const history = both.candidates[0]!.history;
    expect(history.map((h) => h.id)).toEqual([ids.h5, ids.h4, ids.h3]);
    expect(both.candidates[0]!.moreHistory).toBe(true);
    // what a row of history carries — and a colleague's lead is readable: leads_select is org-wide
    expect(history[0]).toMatchObject({
      status: "contacted",
      assigned_agent_id: agentP2.id,
      property: { id: propertyId, reference: `SUG${run}`.slice(0, 20).toUpperCase() },
    });
    expect(history[1]!.property).toBeNull();
  });

  it("shows BOTH contacts when the e-mail and the phone belong to different people", async () => {
    const states = await loadEnquiryContactSuggestions(typed(adminP.client), enquiries());
    const split = matches(states.get(ids.eSplit!));
    expect(split.candidates.map((c) => [c.contact.id, c.matchedOn])).toEqual([
      [ids.maria, "email"],
      [ids.phoneOnly, "phone"],
    ]);
    expect(split.split).toEqual({ emailMatches: ["Maria Georgiou"], phoneMatches: ["Maria Papa"] });
  });

  it("matches a number parked in additional_phones", async () => {
    const states = await loadEnquiryContactSuggestions(typed(adminP.client), enquiries());
    const add = matches(states.get(ids.eAdditional!));
    expect(add.candidates.map((c) => [c.contact.id, c.evidence.phone])).toEqual([[ids.additional, "additional"]]);
  });

  it("never suggests an archived or an erased contact — the erased identifiers stay out of reach", async () => {
    const states = await loadEnquiryContactSuggestions(typed(adminP.client), enquiries());
    expect(states.get(ids.eArchived!)?.status).toBe("no_match");
    expect(states.get(ids.eErased!)?.status).toBe("no_match");
    expect(states.get(ids.eErasedUnarchived!)?.status, "erased_at is tested on its own").toBe("no_match");
    expect(states.get(ids.eNobody!)?.status).toBe("no_match");
  });

  it("gives an agent and a listing manager exactly what an admin sees — reads are org-wide by policy", async () => {
    const asAdmin = await loadEnquiryContactSuggestions(typed(adminP.client), enquiries());
    const asAgent = await loadEnquiryContactSuggestions(typed(agentP1.client), enquiries());
    const asManager = await loadEnquiryContactSuggestions(typed(managerP.client), enquiries());
    expect([...asAgent.entries()]).toEqual([...asAdmin.entries()]);
    expect([...asManager.entries()]).toEqual([...asAdmin.entries()]);
  });

  it("never crosses organisations: the same person at another agency, and its history, stay there", async () => {
    const asP = await loadEnquiryContactSuggestions(typed(adminP.client), enquiries());
    const seenByP = JSON.stringify([...asP.values()]);
    expect(seenByP).not.toContain(ids.mariaQ!);
    expect(seenByP).not.toContain(ids.hQ!);
    // another agency's lead that points at P's OWN contact stays out of its history
    expect(seenByP).not.toContain(ids.foreignOnMaria!);
    expect(matches(asP.get(ids.eBoth!)).candidates[0]!.history.map((h) => h.id)).toEqual([ids.h5, ids.h4, ids.h3]);

    // organisation Q reading the same enquiry text finds ITS contact and ITS history — none of P's
    const asQ = await loadEnquiryContactSuggestions(typed(adminQ.client), [{ id: "probe", message: header(MARIA_EMAIL, null) }]);
    const q = matches(asQ.get("probe"));
    expect(q.candidates.map((c) => c.contact.id)).toEqual([ids.mariaQ]);
    expect(q.candidates[0]!.history.map((h) => h.id)).toEqual([ids.hQ]);
    expect(JSON.stringify(q)).not.toContain(ids.maria!);
  });

  it("reads nothing for a session that has not passed its second factor", async () => {
    const aal1 = anonClient();
    const { error } = await aal1.auth.signInWithPassword({ email: adminP.email, password: TEST_PASSWORD });
    expect(error).toBeNull();
    const states = await loadEnquiryContactSuggestions(typed(aal1), enquiries());
    for (const s of states.values()) expect(s.status === "matches").toBe(false);
    await aal1.auth.signOut();
  });

  it("writes nothing — contacts, leads and the event log are unchanged after every role has looked", async () => {
    const before = await snapshot(ORG_P);
    for (const u of [adminP, agentP1, agentP2, managerP]) await loadEnquiryContactSuggestions(typed(u.client), enquiries());
    expect(await snapshot(ORG_P)).toEqual(before);
  });
});

describe("the conditional link, raced by real sessions", () => {
  const fresh = async (key: string, over: Record<string, unknown> = {}) => {
    await insertLead(key, { received_at: "2099-09-21T09:00:00Z", message: header(MARIA_EMAIL, null), ...over });
    return ids[key]!;
  };
  const current = async (leadId: string) =>
    (await pg.query("select contact_id, status, assigned_agent_id from leads where id = $1", [leadId])).rows[0];

  it("two clicks for the same contact: one write lands, the other is 'already linked'", async () => {
    const leadId = await fresh("raceSame");
    const outcomes = await Promise.all([
      linkUnlinkedLead(typed(adminP.client), leadId, ids.maria!),
      linkUnlinkedLead(typed(agentP1.client), leadId, ids.maria!),
    ]);
    expect([...outcomes].sort()).toEqual(["already_linked", "linked"]);
    expect((await current(leadId)).contact_id).toBe(ids.maria);
  });

  it("two agents, two different contacts: the first write wins and the second changes nothing", async () => {
    const leadId = await fresh("raceDifferent");
    const [a, b] = await Promise.all([
      linkUnlinkedLead(typed(adminP.client), leadId, ids.maria!),
      linkUnlinkedLead(typed(agentP1.client), leadId, ids.phoneOnly!),
    ]);
    expect([a, b].sort()).toEqual(["linked", "linked_elsewhere"]);
    const winner = a === "linked" ? ids.maria : ids.phoneOnly;
    expect((await current(leadId)).contact_id).toBe(winner);

    // and a stale screen coming back later cannot overwrite it either
    const loser = a === "linked" ? ids.phoneOnly! : ids.maria!;
    expect(await linkUnlinkedLead(typed(adminP.client), leadId, loser)).toBe("linked_elsewhere");
    expect((await current(leadId)).contact_id).toBe(winner);
  });

  it("a listing manager, and an agent on a colleague's lead, are refused by the row policy", async () => {
    const unassigned = await fresh("refusedManager");
    expect(await linkUnlinkedLead(typed(managerP.client), unassigned, ids.maria!)).toBe("refused");
    expect((await current(unassigned)).contact_id).toBeNull();

    const colleagues = await fresh("refusedAgent", { assigned_agent_id: agentP2.id });
    expect(await linkUnlinkedLead(typed(agentP1.client), colleagues, ids.maria!)).toBe("refused");
    expect((await current(colleagues)).contact_id).toBeNull();
    expect(await linkUnlinkedLead(typed(agentP2.client), colleagues, ids.maria!)).toBe("linked");
  });

  it("a lead closed after the page was drawn is not linked", async () => {
    const leadId = await fresh("closedMeanwhile", { status: "lost", lost_reason: "test" });
    expect(await linkUnlinkedLead(typed(adminP.client), leadId, ids.maria!)).toBe("closed");
    expect((await current(leadId)).contact_id).toBeNull();
  });

  it("an enquiry redacted after the page was drawn is not re-attached to a named person", async () => {
    const leadId = await fresh("redactedMeanwhile", { message: "[erased at the contact's request]" });
    expect(await linkUnlinkedLead(typed(adminP.client), leadId, ids.maria!)).toBe("redacted");
    expect((await current(leadId)).contact_id).toBeNull();

    // and the redaction guard does not catch a lead whose message is simply empty
    const empty = await fresh("nullMessage", { message: null });
    expect(await linkUnlinkedLead(typed(adminP.client), empty, ids.maria!)).toBe("linked");
  });

  it("another organisation's session cannot link a P lead, even to its own contact", async () => {
    const leadId = await fresh("crossOrg");
    expect(await linkUnlinkedLead(typed(adminQ.client), leadId, ids.mariaQ!)).toBe("refused");
    expect((await current(leadId)).contact_id).toBeNull();
  });

  it("linking changes contact_id and nothing else — status, assignment, clocks, brief and alert rows stay", async () => {
    const leadId = await fresh("lifecycle", {
      status: "contacted",
      assigned_agent_id: agentP1.id,
      received_at: "2099-09-19T07:30:00Z",
      first_response_at: "2099-09-19T08:00:00Z",
      first_call_at: "2099-09-19T08:05:00Z",
      criteria: { channel: "website_form", budget: "over_1m" },
      property_id: propertyId,
      channel: "email",
    });
    const { error: jobErr } = await svc.from("notification_jobs").insert({
      org_id: ORG_P,
      lead_id: leadId,
      kind: "enquiry_desk_alert",
      state: "accepted",
      accepted_at: "2099-09-19T07:31:00Z",
      next_attempt_at: "2099-01-01T00:00:00Z",
    });
    if (jobErr) throw new Error(`job: ${jobErr.message}`);

    const lifecycle = `select status, assigned_agent_id, received_at, first_response_at, first_call_at, criteria,
                              property_id, channel, message, lost_reason, converted_deal_id
                         from leads where id = $1`;
    const jobs = "select kind, state, attempts, accepted_at, next_attempt_at, updated_at from notification_jobs where lead_id = $1 order by kind";
    const leadBefore = (await pg.query(lifecycle, [leadId])).rows[0];
    const jobsBefore = (await pg.query(jobs, [leadId])).rows;
    const otherBefore = await pg.query("select id, contact_id, updated_at from leads where contact_id = $1 order by id", [ids.maria]);

    expect(await linkUnlinkedLead(typed(agentP1.client), leadId, ids.maria!)).toBe("linked");

    expect((await pg.query(lifecycle, [leadId])).rows[0]).toEqual(leadBefore);
    expect((await pg.query(jobs, [leadId])).rows).toEqual(jobsBefore);
    expect((await current(leadId)).contact_id).toBe(ids.maria);
    // Maria's earlier enquiries are separate records and were not touched
    const otherAfter = await pg.query("select id, contact_id, updated_at from leads where contact_id = $1 and id <> $2 order by id", [
      ids.maria,
      leadId,
    ]);
    expect(otherAfter.rows).toEqual(otherBefore.rows);
  });
});
