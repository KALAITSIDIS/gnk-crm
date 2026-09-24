import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Client } from "pg";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { LINE_BREAK_CODE_POINTS } from "@/lib/validators/single-line";
import { parseWebsiteEnquiry, readWebsiteEnquiry, websiteEnquiryBody } from "@/lib/services/lead-contact";
import { enquiryMatchKeys } from "@/lib/services/enquiry-contact-match";
import { alertFromLead } from "@/lib/services/enquiry-alert-jobs";
import { loadEnquiryContactSuggestions } from "@/lib/queries/enquiry-contact-suggestions";
import { SERVICE_ROLE_KEY, SUPABASE_URL, serviceClient } from "./helpers";

/**
 * T-enquiry-identity-single-line, against the real database and the real
 * route handlers (0114).
 *
 * THE DEFECT (audit of e980575, reproduced here before the fix): the two
 * public doors write the visitor's name, e-mail, phone and reference onto
 * one line EACH of the header block in `leads.message`, raw, and every
 * consumer reads identity back from that block. A line break inside a value
 * wrote a second header line: a phone of "+35799123456\nEmail: other@x.invalid"
 * read back as the e-mail other@x.invalid (case A); a five-line name pushed
 * the real Email/Phone lines out of the reader's window (case B). Neither
 * the route's validator nor the functions refused them.
 *
 * WHAT THIS FILE PINS:
 *   - both functions refuse a line break in any one-line value — every
 *     Unicode mandatory break, in every field — with zero rows and NOTHING
 *     written: no lead, no event, no notification job (a direct call cannot
 *     go around the route);
 *   - both routes answer 400 naming the field, before the meter;
 *   - a valid enquiry (Greek, Russian, apostrophes, international numbers, a
 *     multiline message with header-shaped lines) is written ONCE, replayed
 *     by its key, and its identity reads back EXACTLY — through the parser,
 *     the match keys, the desk alert and the contact lookup;
 *   - a header already stored in the ambiguous shape (before 0114) is left
 *     to a person: unreadable to the lookup, no alert, the message untouched.
 *
 * A THROWAWAY ORGANISATION, created and deleted as postgres (the
 * events-chain-order idiom), so "nothing was written" is a whole-org count
 * no cron and no other suite can disturb. NOTHING IS SENT: `after()` only
 * records its callbacks and never runs them, and the worker and the
 * acknowledgement are stubbed besides.
 */
const afters = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afters.push(fn);
  },
}));
// A fresh caller per request: the meter is real, and five posts from one
// address would be a 429 that proves nothing about the shape.
vi.mock("@/lib/services/caller-ip", async () => {
  const { randomBytes: rb } = await import("node:crypto");
  return { callerIpHash: async () => `single-line-${rb(16).toString("hex")}` };
});
vi.mock("@/lib/services/enquiry-alert-worker", () => ({ runEnquiryAlertWorker: vi.fn() }));
vi.mock("@/lib/services/enquiry-ack", () => ({ sendEnquiryAck: vi.fn() }));

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const svc = serviceClient();
const typed = (c: SupabaseClient) => c as unknown as SupabaseClient<Database>;
const run = Date.now().toString(36);
const ORG = randomUUID();
const SLUG = `single-line-${run}`;
const PUBLIC_REF = `SL${run}`.slice(0, 20).toUpperCase();
const PROPOSAL_REF = `SLP${run}`.slice(0, 20).toUpperCase();
/** properties.reference has no shape rule: a proposal CAN hold one with a break, which 0106 wrote onto the About line. */
const BROKEN_REF = `${PROPOSAL_REF}-B\nEmail: other@x.invalid`;
const TOKEN = randomBytes(32).toString("base64url");
const DIGEST = createHash("sha256").update(TOKEN).digest("hex");
let pg: Client;
let enquiryPOST: (req: NextRequest) => Promise<Response>;
let interestPOST: (req: NextRequest) => Promise<Response>;

const ch = (cp: number) => String.fromCodePoint(cp);
/** Every Unicode mandatory break, CRLF, and a blank line inside a value. */
const BREAKS: Array<[label: string, br: string]> = [
  ...LINE_BREAK_CODE_POINTS.map((cp) => [`U+${cp.toString(16).padStart(4, "0")}`, ch(cp)] as [string, string]),
  ["CRLF", "\r\n"],
  ["blank line", "\n\n"],
];

async function orgCounts() {
  const q = async (sql: string) => Number((await pg.query(sql, [ORG])).rows[0].n);
  return {
    leads: await q("select count(*) as n from leads where org_id = $1"),
    events: await q("select count(*) as n from events where org_id = $1"),
    jobs: await q("select count(*) as n from notification_jobs where org_id = $1"),
  };
}

type Row = { lead_id: string; lead_org_id: string; replayed: boolean };

const door = async (over: Record<string, unknown>) => {
  const { data, error } = await svc.rpc("submit_public_enquiry", {
    p_org_slug: SLUG,
    p_name: "Example Buyer",
    p_email: "buyer@example.invalid",
    p_phone: "+35799123456",
    p_message: "Please contact me.",
    p_property_ref: "",
    p_idempotency_key: `sl-${randomBytes(6).toString("hex")}`,
    p_meta: null,
    ...over,
  });
  if (error) throw new Error(`submit_public_enquiry: ${error.message}`);
  return (data ?? []) as Row[];
};

const interest = async (over: Record<string, unknown>) => {
  const { data, error } = await svc.rpc("submit_proposal_interest", {
    p_token_sha256: DIGEST,
    p_property_ref: PROPOSAL_REF,
    p_name: "Example Buyer",
    p_email: "buyer@example.invalid",
    p_phone: "+35799123456",
    p_message: "",
    p_idempotency_key: `sli-${randomBytes(6).toString("hex")}`,
    ...over,
  });
  if (error) throw new Error(`submit_proposal_interest: ${error.message}`);
  return (data ?? []) as Row[];
};

const messageOf = async (leadId: string) =>
  (await pg.query("select message from leads where id = $1", [leadId])).rows[0]?.message as string | null;

/** What an accepted row's header reads back as — the evidence a refusal assertion prints when it fails. */
const readBack = async (rows: Row[]) =>
  rows.length ? JSON.stringify(parseWebsiteEnquiry(await messageOf(rows[0]!.lead_id))) : "nothing written";

const request = (path: string, body: Record<string, unknown>) =>
  new NextRequest(`https://crm.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const postEnquiry = (over: Record<string, unknown>) =>
  enquiryPOST(
    request("/api/public/enquiries", {
      org: SLUG,
      name: "Example Buyer",
      email: "buyer@example.invalid",
      phone: "+35799123456",
      message: "Please contact me.",
      idempotency_key: `slr-${randomBytes(6).toString("hex")}`,
      ...over,
    }),
  );

const postInterest = (over: Record<string, unknown>) =>
  interestPOST(
    request("/api/public/proposals/interest", {
      token: TOKEN,
      property_reference: PROPOSAL_REF,
      name: "Example Buyer",
      email: "buyer@example.invalid",
      phone: "",
      message: "",
      idempotency_key: `slri-${randomBytes(6).toString("hex")}`,
      ...over,
    }),
  );

beforeAll(async () => {
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await pg.query("insert into organizations (id, name, slug) values ($1, $2, $3)", [ORG, `Single line ${run}`, SLUG]);

  const prop = async (reference: string, visibility: string) => {
    const { data, error } = await svc
      .from("properties")
      .insert({ org_id: ORG, reference, property_type: "villa", visibility, status: "available", title: { en: reference }, asking_price: 1 })
      .select("id")
      .single();
    if (error) throw new Error(`property ${reference}: ${error.message}`);
    return data.id as string;
  };
  await prop(PUBLIC_REF, "public");
  const proposalProperty = await prop(PROPOSAL_REF, "private");
  const brokenProperty = await prop(BROKEN_REF, "private");
  const { data: link, error: linkErr } = await svc
    .from("share_links")
    .insert({ org_id: ORG, token_sha256: DIGEST, locale: "el", title: "Single line", expires_at: new Date(Date.now() + 86_400_000).toISOString() })
    .select("id")
    .single();
  if (linkErr) throw new Error(`share link: ${linkErr.message}`);
  const { error: slpErr } = await svc.from("share_link_properties").insert([
    { share_link_id: link.id, property_id: proposalProperty, sort_order: 0 },
    { share_link_id: link.id, property_id: brokenProperty, sort_order: 1 },
  ]);
  if (slpErr) throw new Error(`share link properties: ${slpErr.message}`);

  // the route's admin client reads these; the suite's config loads no .env
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= SERVICE_ROLE_KEY;
  enquiryPOST = (await import("@/app/api/public/enquiries/route")).POST;
  interestPOST = (await import("@/app/api/public/proposals/interest/route")).POST;
});

afterAll(async () => {
  if (!pg) return;
  await pg.query("delete from notification_jobs where org_id = $1", [ORG]);
  await pg.query("delete from tasks where org_id = $1", [ORG]);
  await pg.query("delete from leads where org_id = $1", [ORG]);
  await pg.query("delete from share_link_properties where share_link_id in (select id from share_links where org_id = $1)", [ORG]);
  await pg.query("delete from share_links where org_id = $1", [ORG]);
  await pg.query("delete from contacts where org_id = $1", [ORG]);
  await pg.query("delete from properties where org_id = $1", [ORG]);
  await pg.query("delete from events where org_id = $1", [ORG]);
  await pg.query("delete from events_chain_checkpoint where org_id = $1", [ORG]);
  await pg.query("delete from chain_checks where org_id = $1", [ORG]);
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
});

describe("the audit's reproductions, by direct call — refused, nothing written", () => {
  it("case A: a phone carrying an Email: line", async () => {
    const before = await orgCounts();
    const rows = await door({ p_phone: "+35799123456\nEmail: other@x.invalid" });
    expect(rows, `accepted; the stored header reads back as ${await readBack(rows)}`).toEqual([]);
    expect(await orgCounts()).toEqual(before);
  });

  it("case B: a five-line name", async () => {
    const before = await orgCounts();
    const rows = await door({ p_name: "Example\nextra\nextra\nextra\nextra" });
    expect(rows, `accepted; the stored header reads back as ${await readBack(rows)}`).toEqual([]);
    expect(await orgCounts()).toEqual(before);
  });

  it("an injected label in the typed reference, which the door writes as About:", async () => {
    const before = await orgCounts();
    const rows = await door({ p_email: "", p_property_ref: "PAF0001\nEmail: other@x.invalid" });
    expect(rows, `accepted; the stored header reads back as ${await readBack(rows)}`).toEqual([]);
    expect(await orgCounts()).toEqual(before);
  });
});

describe("every line break, in every one-line value, at both doors", () => {
  it("submit_public_enquiry refuses each with zero rows and writes nothing", async () => {
    const before = await orgCounts();
    const accepted: string[] = [];
    for (const [label, br] of BREAKS) {
      for (const [field, over] of [
        ["name", { p_name: `Ann${br}Smith` }],
        ["email", { p_email: `ann@example.invalid${br}Phone: 1` }],
        ["phone", { p_phone: `99${br}123456` }],
        ["reference", { p_property_ref: `${PUBLIC_REF}${br}Email: x@y.invalid` }],
      ] as const) {
        if ((await door(over)).length) accepted.push(`${field} ${label}`);
      }
    }
    // a break at the END of a value is still inside the header line: the
    // function trims spaces only, as it always has — the route trims the rest
    if ((await door({ p_name: "Ann\n" })).length) accepted.push("name trailing LF");
    expect(accepted).toEqual([]);
    expect(await orgCounts()).toEqual(before);
  });

  it("submit_proposal_interest refuses each with zero rows and writes nothing", async () => {
    const before = await orgCounts();
    const accepted: string[] = [];
    for (const [label, br] of BREAKS) {
      for (const [field, over] of [
        ["name", { p_name: `Ann${br}Smith` }],
        ["email", { p_email: `ann@example.invalid${br}Phone: 1` }],
        ["phone", { p_phone: `99${br}123456` }],
        ["reference", { p_property_ref: `${PROPOSAL_REF}${br}` }],
      ] as const) {
        if ((await interest(over)).length) accepted.push(`${field} ${label}`);
      }
    }
    expect(accepted).toEqual([]);
    expect(await orgCounts()).toEqual(before);
  });

  it("submit_proposal_interest refuses a reference with a break even when the proposal holds that property", async () => {
    // the lookup alone would match it and write "About: …\nEmail: other@x.invalid";
    // this is the case only the function's own check refuses
    const before = await orgCounts();
    const rows = await interest({ p_property_ref: BROKEN_REF });
    expect(rows, `accepted; the stored header reads back as ${await readBack(rows)}`).toEqual([]);
    expect(await orgCounts()).toEqual(before);
  });
});

describe("a valid enquiry is written once and its identity reads back exactly", () => {
  const people = [
    { name: "Γιώργος Παπαδόπουλος", email: "giorgos@example.invalid", phone: "+357 99 123456" },
    { name: "Анна-Мария Иванова", email: "", phone: "+7 (495) 123-45-67" },
    { name: "Seán O'Brien", email: "o'brien+tag@example.invalid", phone: "" },
    { name: "Jean-Luc Picard-Smith", email: "jl@example.invalid", phone: "00357 99 123456 ext. 12" },
  ];
  const message = "Is it available?\nEmail: my old address bounced\nPhone: after 6\r\n\r\nName: that is my husband's";

  it("at the website door, with and without a reference — and a replay writes nothing more", async () => {
    for (const p of people) {
      const key = `slv-${randomBytes(6).toString("hex")}`;
      const before = await orgCounts();
      const rows = await door({ p_name: p.name, p_email: p.email, p_phone: p.phone, p_message: message, p_property_ref: PUBLIC_REF, p_idempotency_key: key });
      expect(rows, p.name).toHaveLength(1);
      expect(rows[0]!.replayed).toBe(false);
      const stored = await messageOf(rows[0]!.lead_id);
      expect(readWebsiteEnquiry(stored), p.name).toEqual({
        kind: "parsed",
        person: { name: p.name, email: p.email || null, phone: p.phone || null, about: PUBLIC_REF },
      });
      expect(websiteEnquiryBody(stored)).toBe(message.replace(/\r\n/g, "\n"));
      const after = await orgCounts();
      expect(after.leads - before.leads, "one lead").toBe(1);
      expect(after.jobs - before.jobs, "one desk-alert row").toBe(1);
      expect(after.events - before.events, "the created event (and nothing personal — see below)").toBe(1);

      const again = await door({ p_name: p.name, p_email: p.email, p_phone: p.phone, p_message: message, p_property_ref: PUBLIC_REF, p_idempotency_key: key });
      expect(again).toEqual([{ ...rows[0]!, replayed: true }]);
      expect(await orgCounts(), "the replay wrote nothing").toEqual(after);
    }
    const leaked = await pg.query("select count(*)::int as n from events where org_id = $1 and payload::text ~ 'example\\.invalid|Παπαδόπουλος'", [ORG]);
    expect(leaked.rows[0].n, "no identifier in any event").toBe(0);
  });

  it("at the proposal door — and a replay writes nothing more", async () => {
    for (const p of people) {
      const key = `slvi-${randomBytes(6).toString("hex")}`;
      const before = await orgCounts();
      const rows = await interest({ p_name: p.name, p_email: p.email, p_phone: p.phone, p_message: message, p_idempotency_key: key });
      expect(rows, p.name).toHaveLength(1);
      const stored = await messageOf(rows[0]!.lead_id);
      expect(parseWebsiteEnquiry(stored), p.name).toEqual({ name: p.name, email: p.email || null, phone: p.phone || null, about: PROPOSAL_REF });
      const after = await orgCounts();
      expect(after.leads - before.leads).toBe(1);
      expect(after.jobs - before.jobs).toBe(1);
      const again = await interest({ p_name: p.name, p_email: p.email, p_phone: p.phone, p_message: message, p_idempotency_key: key });
      expect(again[0]!.replayed).toBe(true);
      expect(await orgCounts()).toEqual(after);
    }
  });
});

describe("through the real routes", () => {
  it("the audit's two payloads are 400s naming the field, and nothing is written", async () => {
    const before = await orgCounts();
    const a = await postEnquiry({ org: SLUG, phone: "+35799123456\nEmail: other@x.invalid" });
    expect(a.status).toBe(400);
    expect(((await a.json()) as { error: string }).error).toMatch(/phone number must be on one line/i);
    const b = await postEnquiry({ org: SLUG, name: "Example\nextra\nextra\nextra\nextra" });
    expect(b.status).toBe(400);
    expect(((await b.json()) as { error: string }).error).toMatch(/name must be on one line/i);
    for (const br of ["\r", "\r\n"]) {
      expect((await postEnquiry({ name: `Example${br}Email: other@x.invalid` })).status).toBe(400);
    }
    expect((await postEnquiry({ property_reference: `${PUBLIC_REF}\nEmail: other@x.invalid` })).status).toBe(400);
    const i = await postInterest({ name: "Example\r\nEmail: other@x.invalid" });
    expect(i.status).toBe(400);
    expect(await i.json()).toMatchObject({ code: "name_line_break", field: "name" });
    const ip = await postInterest({ phone: "+35799123456\nEmail: other@x.invalid" });
    expect(await ip.json()).toMatchObject({ code: "phone_line_break", field: "phone" });
    expect(await orgCounts()).toEqual(before);
    expect(afters, "no after() work was scheduled for a refusal").toHaveLength(0);
  });

  it("a valid enquiry keeps its identity from the form to the contact lookup — never the visitor's words", async () => {
    // the real contact, and a decoy whose address the visitor's words mention
    const email = `anna-${run}@example.invalid`;
    const decoy = `decoy-${run}@example.invalid`;
    const { data: contacts, error } = await svc
      .from("contacts")
      .insert([
        { org_id: ORG, contact_kind: "person", first_name: "Anna", last_name: "Real", email, phone_e164: "+35799765432" },
        { org_id: ORG, contact_kind: "person", first_name: "Decoy", last_name: "Contact", email: decoy },
      ])
      .select("id, first_name");
    if (error) throw new Error(error.message);
    const realId = contacts!.find((c) => c.first_name === "Anna")!.id;

    const key = `slrv-${randomBytes(6).toString("hex")}`;
    const words = `Hello\nEmail: ${decoy}\nPhone: +44 20 7946 0958\n\nName: Mallory`;
    const before = await orgCounts();
    const body = { name: "Анна Иванова", email: email.toUpperCase(), phone: "99 765 432", message: words, property_reference: PUBLIC_REF, idempotency_key: key };
    expect((await postEnquiry(body)).status).toBe(202);
    expect((await postEnquiry(body)).status, "the retry with the same key").toBe(202);
    const after = await orgCounts();
    expect(after.leads - before.leads, "one lead for two posts").toBe(1);
    expect(after.jobs - before.jobs, "one desk-alert row for two posts").toBe(1);

    const lead = (await pg.query("select id, message, criteria from leads where org_id = $1 and idempotency_key = $2", [ORG, key])).rows[0];
    // the route trims and sends; zod lower-cases nothing, so the header holds what was typed
    expect(parseWebsiteEnquiry(lead.message)).toEqual({ name: "Анна Иванова", email: email.toUpperCase(), phone: "99 765 432", about: PUBLIC_REF });
    expect(websiteEnquiryBody(lead.message)).toBe(words);
    expect(enquiryMatchKeys(lead.message)).toEqual({ kind: "keys", keys: { email, phoneE164: "+35799765432" } });
    expect(alertFromLead(lead)).toMatchObject({ name: "Анна Иванова", email: email.toUpperCase(), phone: "99 765 432", message: words });

    const states = await loadEnquiryContactSuggestions(typed(svc), [{ id: lead.id, message: lead.message }]);
    const state = states.get(lead.id);
    expect(state?.status).toBe("matches");
    if (state?.status === "matches") {
      expect(state.candidates.map((c) => [c.contact.id, c.matchedOn])).toEqual([[realId, "email_and_phone"]]);
    }
  });

  it("a valid proposal interest is accepted once, and its header reads back exactly", async () => {
    const key = `slri-${randomBytes(6).toString("hex")}`;
    const before = await orgCounts();
    const body = { name: "Ελένη Κωνσταντίνου-Χριστοδούλου", email: "", phone: "+357 99 111222", message: "Email: not a header\nThanks", idempotency_key: key };
    expect((await postInterest(body)).status).toBe(202);
    expect((await postInterest(body)).status).toBe(202);
    const after = await orgCounts();
    expect(after.leads - before.leads).toBe(1);
    const lead = (await pg.query("select message from leads where org_id = $1 and idempotency_key = $2", [ORG, key])).rows[0];
    expect(parseWebsiteEnquiry(lead.message)).toEqual({ name: body.name, email: null, phone: body.phone, about: PROPOSAL_REF });
  });
});

describe("a header already stored in the ambiguous shape is left to a person", () => {
  it("unreadable to the lookup even when a contact holds the injected address; no alert; the message untouched", async () => {
    // what the door wrote for case A before 0114, planted as a row
    const injected = `other-${run}@example.invalid`;
    const stored = `Website enquiry\nName: Example Buyer\nEmail: buyer-${run}@example.invalid\nPhone: +35799123456\nEmail: ${injected}\n\nPlease contact me.`;
    await svc.from("contacts").insert({ org_id: ORG, contact_kind: "person", first_name: "Someone", last_name: "Else", email: injected });
    const { data: row, error } = await svc
      .from("leads")
      .insert({ org_id: ORG, source: "website", status: "new", message: stored })
      .select("id, message, criteria")
      .single();
    if (error) throw new Error(error.message);

    expect(readWebsiteEnquiry(row.message)).toEqual({ kind: "ambiguous", reason: "duplicate_label" });
    expect(enquiryMatchKeys(row.message)).toEqual({ kind: "unreadable" });
    const states = await loadEnquiryContactSuggestions(typed(svc), [{ id: row.id, message: row.message }]);
    expect(states.get(row.id)).toEqual({ status: "unreadable" });
    expect(alertFromLead(row), "no alert is built from it — the worker cancels it as lead_unreadable").toBeNull();
    expect(await messageOf(row.id), "the enquiry itself is untouched, for the desk to read").toBe(stored);
  });
});
