import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ANON_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * GDPR erasure and the retention purge never read a hollow answer as "none" —
 * through the REAL `eraseContactPersonalData` and `purgeExpiredRetention`, a
 * real aal2 admin session, the real service-role client, a REAL PostgREST
 * behind the local Kong (T-erasure-null-answers).
 *
 * postgrest-js reports an OK answer with an empty body, a 404 with an empty
 * body (as 204) and a `null` body even under a 500 as `data: null, error:
 * null`, and a 500 whose body is `0` as a FALSY error (measured, 2.110.2). At
 * 467b856 every erasure step threw on a truthy error only and then read
 * `data ?? []`; measured with this harness:
 *   - a hollow deals / viewings / viewing-slips / mandates answer for a
 *     contact WITH that relationship erased it with aml_basis false and
 *     DESTROYED the KYC file the AML duty requires keeping;
 *   - a hollow document listing recorded the erasure with the file and its
 *     row still there, and a re-run was then refused as already erased;
 *   - a hollow listing in the purge cleared the retention date and recorded
 *     0 destroyed with the file still there;
 *   - a hollow erased-event check on a re-run wrote a SECOND `erased` event.
 *
 * A fault is the only way such an answer arrives, so the test injects it: the
 * session client's and the service client's `fetch` send ONE request (matched
 * by method and URL) to the real stack and lose its body on the way back — the
 * request happens, as when an edge strips the answer. Every fault case asserts
 * that it reached exactly that request; a control on the same contact shows
 * the fixture carries what the fault hid.
 *
 * THROWAWAY ORGANISATION, deleted at the end as postgres, storage included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);

/**
 * One faulty request (or `times` of them): matched by method and URL. `forward`
 * (default) sends it to the stack and loses the answer — the write LANDS;
 * without it the request never arrives — the write does not land.
 */
type Hollow = { match: (method: string, url: string) => boolean; answer: () => Response; forward?: boolean; times?: number };

const state = vi.hoisted(() => ({
  queue: [] as unknown[],
  adminWrites: [] as string[],
  adminHollow: null as Hollow | null,
  /** runs before a service-role request is sent — a concurrent writer, say */
  adminBefore: null as ((method: string, url: string) => Promise<void>) | null,
  hits: [] as string[],
}));

/** Answer `fault`'s request (counting it), or null to send the request as it is. */
async function faulted(fault: Hollow | null, where: string, method: string, url: string, send: () => Promise<Response>) {
  if (!fault?.match(method, url) || (fault.times ?? 1) <= 0) return null;
  fault.times = (fault.times ?? 1) - 1;
  state.hits.push(`${where} ${method} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  if (fault.forward ?? true) await (await send()).arrayBuffer();
  return fault.answer();
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect(${to})`);
  },
  notFound: () => {
    throw new Error("notFound()");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = state.queue.shift();
    if (!c) throw new Error("test harness: no client queued for this action");
    return c;
  },
}));
// the real service-role client: its writes recorded, one request optionally hollowed
vi.mock("@/lib/supabase/admin", async () => {
  const { createClient: make } = await import("@supabase/supabase-js");
  const h = await import("./helpers");
  return {
    createAdminClient: () =>
      make(h.SUPABASE_URL, h.SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = (init?.method ?? "GET").toUpperCase();
            const url = decodeURIComponent(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
            if (method !== "GET" && method !== "HEAD") state.adminWrites.push(`${method} ${new URL(url).pathname}`);
            await state.adminBefore?.(method, url);
            return (await faulted(state.adminHollow, "admin", method, url, () => fetch(input, init))) ?? fetch(input, init);
          },
        },
      }),
  };
});

import { revalidatePath } from "next/cache";
import { eraseContactPersonalData, purgeExpiredRetention } from "@/lib/actions/contact-erasure";

const JSONH = { "content-type": "application/json; charset=utf-8" };
const ANSWERS = {
  "200 empty": { answer: () => new Response("", { status: 200, headers: JSONH }), status: "HTTP 200" },
  "404 empty": { answer: () => new Response("", { status: 404, headers: JSONH }), status: "HTTP 204" },
  "200 null": { answer: () => new Response("null", { status: 200, headers: JSONH }), status: "HTTP 200" },
  "500 null": { answer: () => new Response("null", { status: 500, headers: JSONH }), status: "HTTP 500" },
  "500 0": { answer: () => new Response("0", { status: 500, headers: JSONH }), status: "HTTP 500" },
} as const;
type Shape = keyof typeof ANSWERS;
/** One request: a PostgREST table, a method, and needles its URL carries. */
const rest =
  (method: string, table: string, ...needles: string[]) =>
  (m: string, url: string) =>
    m === method && url.includes(`/rest/v1/${table}?`) && needles.every((n) => url.includes(n));
const hollow = (match: Hollow["match"], shape: Shape = "200 empty", opts: { forward?: boolean; times?: number } = {}): Hollow => ({
  match,
  answer: ANSWERS[shape].answer,
  ...opts,
});

let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let wonStage = "";
const storagePaths: string[] = [];
let n = 0;

/** The admin's aal2 session; the ONE request `fault` matches goes to the stack and comes back hollow. */
async function sessionFor(user: TestUser, fault: Hollow | null) {
  const s = (await user.client.auth.getSession()).data.session!;
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        const url = decodeURIComponent(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return (await faulted(fault, "session", method, url, () => fetch(input, init))) ?? fetch(input, init);
      },
    },
  });
  const { error } = await c.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession: ${error.message}`);
  return c;
}

async function newContact(): Promise<string> {
  n += 1;
  const { data, error } = await svc
    .from("contacts")
    .insert({
      org_id: ORG,
      first_name: `Hollow${n}`,
      last_name: RUN,
      notes: `Private note ${n}`,
      temperature: "hot",
      consent_marketing: true,
      consent_at: new Date().toISOString(),
      kyc: { passport: { done: true } },
      assigned_agent_id: admin.id,
      created_by: admin.id,
    })
    .select("id")
    .single();
  if (error) throw new Error(`contact fixture: ${error.message}`);
  return data.id as string;
}
async function newProperty(): Promise<string> {
  n += 1;
  return (
    await pg.query<{ id: string }>(
      "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id",
      [ORG, `ENA${RUN}${n}`.toUpperCase()],
    )
  ).rows[0]!.id;
}
/** A won deal (as postgres: a session cannot create a deal already won), 2015 — retention ran to 2020. */
async function wonDeal(contactId: string) {
  await pg.query(
    `insert into deals (org_id, deal_type, stage_id, title, status, won_at, buyer_contact_id)
     values ($1, 'sale', $2, $3, 'won', '2015-06-01T09:00:00Z', $4)`,
    [ORG, wonStage, `Deal ${RUN} ${contactId}`, contactId],
  );
}
/** A viewing with a slip signed 2015-06-01. */
async function signedSlip(contactId: string): Promise<string> {
  const property = await newProperty();
  const viewing = (
    await pg.query<{ id: string }>(
      "insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at) values ($1, $2, $3, $4, '2015-06-01T08:00:00Z') returning id",
      [ORG, property, contactId, admin.id],
    )
  ).rows[0]!.id;
  await pg.query(
    "insert into viewing_slips (org_id, viewing_id, signer_name, signature_path, signature_sha256, signed_at) values ($1, $2, 'Signer', $3, $4, '2015-06-01T09:00:00Z')",
    [ORG, viewing, `${ORG}/${viewing}.png`, "0".repeat(64)],
  );
  return viewing;
}
/** A mandate the contact owns, expired 2015-06-01. */
async function ownMandate(contactId: string) {
  const property = await newProperty();
  await pg.query(
    `insert into mandates (org_id, property_id, owner_contact_id, status, type, start_date, expiry_date, renewal_reminder_days)
     values ($1, $2, $3, 'expired', 'open', '2014-06-01', '2015-06-01', 30)`,
    [ORG, property, contactId],
  );
}
/** A KYC document: the storage object and its row. */
async function kycDocument(contactId: string): Promise<{ id: string; path: string }> {
  const path = `${ORG}/contacts/${contactId}/${randomUUID()}.pdf`;
  const up = await svc.storage.from("documents").upload(path, new Blob(["%PDF-1.4 kyc"], { type: "application/pdf" }));
  if (up.error) throw new Error(`storage fixture: ${up.error.message}`);
  storagePaths.push(path);
  const { data, error } = await svc
    .from("documents")
    .insert({ org_id: ORG, entity_type: "contact", entity_id: contactId, doc_type: "id_document", title: "Passport", storage_path: path, visibility: "admin_only" })
    .select("id")
    .single();
  if (error) throw new Error(`document fixture: ${error.message}`);
  return { id: data.id as string, path };
}

const objectExists = async (path: string) => (await svc.storage.from("documents").exists(path)).data === true;
const docRows = async (id: string) => (await pg.query("select count(*)::int as c from documents where id = $1", [id])).rows[0].c as number;
const row = async (id: string) =>
  (await pg.query("select to_jsonb(c) - 'updated_at' as r from contacts c where id = $1", [id])).rows[0].r as Record<string, unknown>;
const events = async (id: string, type: string) =>
  (await pg.query("select payload from events where entity_type = 'contact' and entity_id = $1 and event_type = $2 order by id", [id, type])).rows.map(
    (r) => r.payload as Record<string, unknown>,
  );
const displayName = async (id: string) => (await pg.query("select display_name from contacts where id = $1", [id])).rows[0].display_name as string;

/** Run the erasure (or the purge) with at most one hollow request, on the session or the service client. */
async function run(kind: "erase" | "purge", c: string, fault: { on: "session" | "admin"; hollow: Hollow } | null = null) {
  state.hits = [];
  state.adminWrites = [];
  state.adminHollow = fault?.on === "admin" ? fault.hollow : null;
  state.queue.push(await sessionFor(admin, fault?.on === "session" ? fault.hollow : null));
  try {
    const result = kind === "erase" ? await eraseContactPersonalData(c, await displayName(c)) : await purgeExpiredRetention(c);
    return { result: result as { error: string | null; erasedAt?: string | null; purgedAt?: string | null }, hits: [...state.hits], adminWrites: [...state.adminWrites] };
  } finally {
    state.adminHollow = null;
    state.adminBefore = null;
  }
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Erasure null answers ${RUN}`, `erasure-null-answers-${RUN}`);
  admin = await createTestUser(svc, `ena-admin-${RUN}@test.local`, "admin", ORG);
  wonStage = (await pg.query<{ id: string }>("select id from deal_stages where org_id = $1 and deal_type = 'sale' and is_won limit 1", [ORG])).rows[0]!.id;
}, 180_000);

afterAll(async () => {
  if (storagePaths.length) await svc.storage.from("documents").remove(storagePaths);
  for (const t of ["documents", "viewing_slips", "viewings", "deals", "mandates", "tasks", "properties", "interaction_notes", "buyer_requirements", "leads", "contacts"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  if (admin) await svc.auth.admin.deleteUser(admin.id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
}, 180_000);

afterEach(() => {
  expect(state.queue, "a queued client no action consumed").toEqual([]);
});

// ---------------------------------------------------------------------------
/** What a refused basis read must leave: nothing written, nothing destroyed. */
async function expectNothingDone(c: string, doc: { id: string; path: string }, before: Record<string, unknown>, r: Awaited<ReturnType<typeof run>>) {
  expect(r.result.erasedAt ?? r.result.purgedAt ?? null).toBeNull();
  expect(r.hits, "the fault reached its one request").toHaveLength(1);
  expect(r.adminWrites, "no system write").toEqual([]);
  expect(await objectExists(doc.path), "the KYC file is kept").toBe(true);
  expect(await docRows(doc.id), "its row is kept").toBe(1);
  expect(await row(c), "the contact is untouched").toEqual(before);
  expect(await events(c, "erased")).toEqual([]);
}

/** The control: the same contact, no fault — the basis the fault hid is there, the file retained. */
async function expectRetainedOnRerun(c: string, doc: { id: string; path: string }) {
  const r = await run("erase", c);
  expect(r.result).toEqual({ error: null, erasedAt: expect.any(String) });
  expect(r.hits).toEqual([]);
  expect(await objectExists(doc.path)).toBe(true);
  expect(await events(c, "erased")).toEqual([
    expect.objectContaining({ aml_basis: true, retention_until: "2020-06-01", documents_deleted: 0, documents_retained: 1 }),
  ]);
}

describe("a hollow basis read is no basis it could establish — nothing is erased, the KYC file is kept", () => {
  it.each(Object.keys(ANSWERS) as Shape[])("a won deal, the deals read answered %s", async (shape) => {
    const c = await newContact();
    await wonDeal(c);
    const doc = await kycDocument(c);
    const before = await row(c);
    const r = await run("erase", c, { on: "session", hollow: hollow(rest("GET", "deals", `buyer_contact_id.eq.${c}`), shape) });
    console.log(`[evidence] deals ${shape}: ${JSON.stringify(r.result)}; system writes ${r.adminWrites.length}`);
    expect(r.result.error).toBe(
      `Could not establish the retention basis — nothing was erased: deals: the answer held no rows (${ANSWERS[shape].status})`,
    );
    await expectNothingDone(c, doc, before, r);
    await expectRetainedOnRerun(c, doc);
  });

  it("a signed slip, the viewings read answered empty", async () => {
    const c = await newContact();
    await signedSlip(c);
    const doc = await kycDocument(c);
    const before = await row(c);
    const r = await run("erase", c, { on: "session", hollow: hollow(rest("GET", "viewings", `contact_id=eq.${c}`)) });
    expect(r.result.error).toBe("Could not establish the retention basis — nothing was erased: viewings: the answer held no rows (HTTP 200)");
    await expectNothingDone(c, doc, before, r);
    await expectRetainedOnRerun(c, doc);
  });

  it("a signed slip, the viewing-slips read answered empty", async () => {
    const c = await newContact();
    const viewing = await signedSlip(c);
    const doc = await kycDocument(c);
    const before = await row(c);
    const r = await run("erase", c, { on: "session", hollow: hollow(rest("GET", "viewing_slips", viewing)) });
    expect(r.result.error).toBe("Could not establish the retention basis — nothing was erased: viewing slips: the answer held no rows (HTTP 200)");
    await expectNothingDone(c, doc, before, r);
    await expectRetainedOnRerun(c, doc);
  });

  it("an owned mandate, the mandates read answered empty", async () => {
    const c = await newContact();
    await ownMandate(c);
    const doc = await kycDocument(c);
    const before = await row(c);
    const r = await run("erase", c, { on: "session", hollow: hollow(rest("GET", "mandates_safe", `owner_contact_id=eq.${c}`)) });
    expect(r.result.error).toBe("Could not establish the retention basis — nothing was erased: mandates: the answer held no rows (HTTP 200)");
    await expectNothingDone(c, doc, before, r);
    await expectRetainedOnRerun(c, doc);
  });
});

describe("a hollow answer to any erasure step stops the run before the contact is marked — a re-run finishes", () => {
  // no basis: the file is destroyed by a complete run
  const STEPS: [string, "session" | "admin", Hollow["match"], string][] = [
    ["the lead redaction's rows", "session", rest("PATCH", "leads"), "Erasure stopped while redacting lead messages: leads: the answer held no rows (HTTP 200). Nothing already done is lost — run it again to finish."],
    ["the contact's leads", "session", rest("GET", "leads", "select=id&contact_id"), "Erasure stopped while redacting notes: the contact's leads: the answer held no rows (HTTP 200). Nothing already done is lost — run it again to finish."],
    ["the note redaction's rows", "admin", rest("PATCH", "interaction_notes", "entity_type=eq.contact"), "Erasure stopped while redacting notes: the contact's notes: the answer held no rows (HTTP 200). Nothing already done is lost — run it again to finish."],
    ["the saved searches' rows", "session", rest("DELETE", "buyer_requirements"), "Erasure stopped while deleting saved searches: saved searches: the answer held no rows (HTTP 200). Nothing already done is lost — run it again to finish."],
    ["the document listing", "session", rest("GET", "documents", "entity_type=eq.contact"), "Erasure stopped while listing documents: documents: the answer held no rows (HTTP 200). Nothing already done is lost — run it again to finish."],
  ];
  it.each(STEPS)("%s answered empty", async (_, on, match, message) => {
    const c = await newContact();
    const doc = await kycDocument(c);
    const before = await row(c);
    const r = await run("erase", c, { on, hollow: hollow(match) });
    expect(r.result).toEqual({ error: message, erasedAt: null });
    expect(r.hits).toHaveLength(1);
    expect(r.adminWrites.filter((w) => !w.startsWith("PATCH /rest/v1/interaction_notes")), "nothing destroyed, nothing marked").toEqual([]);
    expect(await objectExists(doc.path)).toBe(true);
    expect(await docRows(doc.id)).toBe(1);
    expect(await row(c)).toEqual(before);
    expect(await events(c, "erased")).toEqual([]);
    // the re-run the message promises
    const again = await run("erase", c);
    expect(again.result).toEqual({ error: null, erasedAt: expect.any(String) });
    expect(await objectExists(doc.path)).toBe(false);
    expect(await events(c, "erased")).toEqual([expect.objectContaining({ aml_basis: false, documents_deleted: 1 })]);
  });

  it("a contact with a lead, the lead notes' redaction answered empty", async () => {
    const c = await newContact();
    await pg.query("insert into leads (org_id, contact_id) values ($1, $2)", [ORG, c]);
    const doc = await kycDocument(c);
    const before = await row(c);
    const r = await run("erase", c, { on: "admin", hollow: hollow(rest("PATCH", "interaction_notes", "entity_type=eq.lead")) });
    expect(r.result).toEqual({
      error: "Erasure stopped while redacting notes: the leads' notes: the answer held no rows (HTTP 200). Nothing already done is lost — run it again to finish.",
      erasedAt: null,
    });
    expect(r.hits).toHaveLength(1);
    expect(await objectExists(doc.path)).toBe(true);
    expect(await row(c)).toEqual(before);
    expect(await events(c, "erased")).toEqual([]);
    const again = await run("erase", c);
    expect(again.result).toEqual({ error: null, erasedAt: expect.any(String) });
    expect(await events(c, "erased")).toEqual([expect.objectContaining({ aml_basis: false, documents_deleted: 1 })]);
  });

  /*
   * A lost answer to a write that LANDED is settled in the run by reading what
   * is left as the system — never handed to a re-run, which would find nothing
   * left and record the destruction as 0 (the review measured exactly that).
   */
  it("the document-row delete landed, its answer lost: the run proves the rows gone and records the destruction", async () => {
    const c = await newContact();
    const doc = await kycDocument(c);
    const r = await run("erase", c, { on: "admin", hollow: hollow(rest("DELETE", "documents")) });
    expect(r.result).toEqual({ error: null, erasedAt: expect.any(String) });
    expect(r.hits).toHaveLength(1);
    expect(await objectExists(doc.path)).toBe(false);
    expect(await docRows(doc.id)).toBe(0);
    expect(await events(c, "erased")).toEqual([
      expect.objectContaining({ aml_basis: false, documents_deleted: 1, documents_retained: 0 }),
    ]);
  });

  it("the document-row delete never arrived: the run stops before the contact is marked — the re-run counts what it deletes", async () => {
    const c = await newContact();
    const doc = await kycDocument(c);
    const before = await row(c);
    const r = await run("erase", c, { on: "admin", hollow: hollow(rest("DELETE", "documents"), "500 null", { forward: false }) });
    expect(r.result).toEqual({
      error: "Erasure stopped while deleting document rows: document rows: 1 of 1 listed row(s) remain after an unconfirmed delete. Nothing already done is lost — run it again to finish.",
      erasedAt: null,
    });
    expect(r.hits).toHaveLength(1);
    expect(await objectExists(doc.path), "the file was removed before the rows").toBe(false);
    expect(await docRows(doc.id)).toBe(1);
    expect(await row(c), "not marked erased").toEqual(before);
    expect(await events(c, "erased")).toEqual([]);
    const again = await run("erase", c);
    expect(again.result).toEqual({ error: null, erasedAt: expect.any(String) });
    expect(await docRows(doc.id)).toBe(0);
    expect(await events(c, "erased")).toEqual([
      expect.objectContaining({ aml_basis: false, documents_deleted: 1, documents_retained: 0 }),
    ]);
  });

  it("the contact patch landed, its answer lost: the run sees its own marker and writes the record", async () => {
    const c = await newContact();
    const doc = await kycDocument(c);
    const r = await run("erase", c, { on: "admin", hollow: hollow(rest("PATCH", "contacts")) });
    expect(r.result).toEqual({ error: null, erasedAt: expect.any(String) });
    expect(r.hits).toHaveLength(1);
    expect((await row(c)).erased_at).not.toBeNull();
    expect(await objectExists(doc.path)).toBe(false);
    expect(await events(c, "erased")).toEqual([expect.objectContaining({ aml_basis: false, documents_deleted: 1 })]);
  });

  it("the contact patch never arrived: the failure stands, nothing marked — a re-run finishes", async () => {
    const c = await newContact();
    await kycDocument(c);
    const r = await run("erase", c, { on: "admin", hollow: hollow(rest("PATCH", "contacts"), "500 null", { forward: false }) });
    expect(r.result).toEqual({
      error: "Erasure stopped while redacting the contact: the contact: the answer held no rows (HTTP 500). Run it again to finish.",
      erasedAt: null,
    });
    expect((await row(c)).erased_at).toBeNull();
    expect(await events(c, "erased")).toEqual([]);
    const again = await run("erase", c);
    expect(again.result).toEqual({ error: null, erasedAt: expect.any(String) });
    expect(await events(c, "erased")).toHaveLength(1);
  });

  it("the row delete never arrived AND the re-read comes back empty: unproven is not deleted — the run stops", async () => {
    const c = await newContact();
    const doc = await kycDocument(c);
    const before = await row(c);
    const deleteOrReread = (m: string, url: string) =>
      (m === "DELETE" && url.includes("/rest/v1/documents?")) || (m === "GET" && url.includes("/rest/v1/documents?select=id&org_id"));
    const r = await run("erase", c, { on: "admin", hollow: hollow(deleteOrReread, "200 empty", { forward: false, times: 2 }) });
    expect(r.result).toEqual({
      error: "Erasure stopped while deleting document rows: document rows (re-read after an unconfirmed delete): the answer held no rows (HTTP 200). Nothing already done is lost — run it again to finish.",
      erasedAt: null,
    });
    expect(r.hits).toHaveLength(2);
    expect(await docRows(doc.id), "the row was never deleted").toBe(1);
    expect(await row(c)).toEqual(before);
    expect(await events(c, "erased")).toEqual([]);
  });

  it("the contact patch never arrived AND the re-read comes back empty: the run stops, naming the re-read", async () => {
    const c = await newContact();
    await kycDocument(c);
    const patchOrReread = (m: string, url: string) =>
      (m === "PATCH" && url.includes("/rest/v1/contacts?")) || (m === "GET" && url.includes("/rest/v1/contacts?select=erased_at"));
    const r = await run("erase", c, { on: "admin", hollow: hollow(patchOrReread, "200 empty", { forward: false, times: 2 }) });
    expect(r.result).toEqual({
      error: "Erasure stopped while redacting the contact: the contact (re-read after an unconfirmed patch): the answer held no rows (HTTP 200). Run it again to finish.",
      erasedAt: null,
    });
    expect(r.hits).toHaveLength(2);
    expect((await row(c)).erased_at).toBeNull();
    expect(await events(c, "erased")).toEqual([]);
  });

  it("someone else erased it meanwhile and this patch's answer was lost: their marker is not this run's — 'erased meanwhile'", async () => {
    const c = await newContact();
    await kycDocument(c);
    // the same admin, another instant: only this run's own marker is this run's
    state.adminBefore = async (method, url) => {
      if (method === "PATCH" && url.includes("/rest/v1/contacts?")) {
        await pg.query("update contacts set erased_at = '2026-01-01T09:00:00Z', erased_by = $2 where id = $1", [c, admin.id]);
      }
    };
    const r = await run("erase", c, { on: "admin", hollow: hollow(rest("PATCH", "contacts")) });
    expect(r.result).toEqual({ error: "This contact was erased meanwhile — reload the page to see its record.", erasedAt: null });
    expect(r.hits).toHaveLength(1);
    expect(await events(c, "erased")).toEqual([]);
  });

  it("the control: a genuine zero-row patch — erased meanwhile by someone else — is still 'erased meanwhile', with no record", async () => {
    const c = await newContact();
    await kycDocument(c);
    // a concurrent erasure lands just before this run's patch
    state.adminBefore = async (method, url) => {
      if (method === "PATCH" && url.includes("/rest/v1/contacts?")) {
        await pg.query("update contacts set erased_at = now(), erased_by = $2 where id = $1", [c, admin.id]);
      }
    };
    const r = await run("erase", c);
    expect(r.result).toEqual({ error: "This contact was erased meanwhile — reload the page to see its record.", erasedAt: null });
    expect(await events(c, "erased")).toEqual([]);
  });

  it("a re-run whose erased-event check is answered empty is refused — never a second record", async () => {
    const c = await newContact();
    await kycDocument(c);
    expect((await run("erase", c)).result).toEqual({ error: null, erasedAt: expect.any(String) });
    // a document linked to the erased contact since
    const later = await kycDocument(c);
    const r = await run("erase", c, { on: "session", hollow: hollow(rest("GET", "events", `entity_id=eq.${c}`, "event_type=eq.erased")) });
    expect(r.result).toEqual({
      error: "Could not check the erasure record — nothing was changed: the erasure record: the answer held no rows (HTTP 200)",
      erasedAt: null,
    });
    expect(r.hits).toHaveLength(1);
    expect(r.adminWrites).toEqual([]);
    expect(await events(c, "erased")).toHaveLength(1);
    expect(await objectExists(later.path)).toBe(true);
    // the control: the check answered, the run is refused as done
    expect((await run("erase", c)).result).toEqual({ error: "This contact's personal data has already been erased.", erasedAt: null });
  });
});

describe("the retention purge never reads a hollow answer as 'nothing retained'", () => {
  /** An erased contact whose KYC file was retained until 2020-06-01 — long expired. */
  async function retained() {
    const c = await newContact();
    await ownMandate(c);
    const doc = await kycDocument(c);
    expect((await run("erase", c)).result).toEqual({ error: null, erasedAt: expect.any(String) });
    const before = await row(c);
    expect(before.retention_until).toBe("2020-06-01");
    return { c, doc, before };
  }
  const purged = async (c: string) => events(c, "retention_purged");

  it.each(["200 empty", "500 0"] as Shape[])("the document listing answered %s: nothing destroyed, the date kept", async (shape) => {
    const { c, doc, before } = await retained();
    const r = await run("purge", c, { on: "session", hollow: hollow(rest("GET", "documents", `entity_id=eq.${c}`), shape) });
    console.log(`[evidence] purge listing ${shape}: ${JSON.stringify(r.result)}`);
    expect(r.result).toEqual({
      error: `Could not list the retained documents — nothing was destroyed: the retained documents: the answer held no rows (${ANSWERS[shape].status})`,
      purgedAt: null,
    });
    expect(r.hits).toHaveLength(1);
    expect(r.adminWrites).toEqual([]);
    expect(await objectExists(doc.path)).toBe(true);
    expect(await docRows(doc.id)).toBe(1);
    expect(await row(c), "the retention date and the checklist are kept").toEqual(before);
    expect(await purged(c)).toEqual([]);
    // the control: no fault, the purge destroys and records
    const again = await run("purge", c);
    expect(again.result).toEqual({ error: null, purgedAt: expect.any(String) });
    expect(await objectExists(doc.path)).toBe(false);
    expect(await docRows(doc.id)).toBe(0);
    expect(await purged(c)).toEqual([{ documents_destroyed: 1, retention_until: "2020-06-01" }]);
  });

  const DESTROYED_ONE = [{ documents_destroyed: 1, retention_until: "2020-06-01" }];

  it("the document delete landed, its answer lost: the purge proves the rows gone and records 1 destroyed", async () => {
    const { c, doc } = await retained();
    const r = await run("purge", c, { on: "admin", hollow: hollow(rest("DELETE", "documents")) });
    expect(r.result).toEqual({ error: null, purgedAt: expect.any(String) });
    expect(r.hits).toHaveLength(1);
    expect(await objectExists(doc.path)).toBe(false);
    expect(await docRows(doc.id)).toBe(0);
    expect((await row(c)).retention_until).toBeNull();
    expect(await purged(c)).toEqual(DESTROYED_ONE);
  });

  it("the document delete never arrived: refused before the date is cleared — the re-run deletes and counts the rows", async () => {
    const { c, doc, before } = await retained();
    const r = await run("purge", c, { on: "admin", hollow: hollow(rest("DELETE", "documents"), "500 null", { forward: false }) });
    expect(r.result).toEqual({
      error: "The files are gone but their records were not deleted: the document records: 1 of 1 remain after an unconfirmed delete. Run it again to finish.",
      purgedAt: null,
    });
    expect(r.hits).toHaveLength(1);
    expect(r.adminWrites).not.toContain("PATCH /rest/v1/contacts");
    expect(await objectExists(doc.path)).toBe(false);
    expect(await docRows(doc.id)).toBe(1);
    expect((await row(c)).retention_until, "the date is kept for the re-run").toBe(before.retention_until);
    expect(await purged(c)).toEqual([]);
    const again = await run("purge", c);
    expect(again.result).toEqual({ error: null, purgedAt: expect.any(String) });
    expect(await docRows(doc.id)).toBe(0);
    expect(await purged(c)).toEqual(DESTROYED_ONE);
  });

  it("the document delete never arrived AND the re-read comes back empty: unproven is not destroyed — the date is kept", async () => {
    const { c, doc, before } = await retained();
    const deleteOrReread = (m: string, url: string) =>
      (m === "DELETE" && url.includes("/rest/v1/documents?")) || (m === "GET" && url.includes("/rest/v1/documents?select=id&org_id"));
    const r = await run("purge", c, { on: "admin", hollow: hollow(deleteOrReread, "200 empty", { forward: false, times: 2 }) });
    expect(r.result).toEqual({
      error: "The files are gone but their records were not deleted: the document records (re-read after an unconfirmed delete): the answer held no rows (HTTP 200). Run it again to finish.",
      purgedAt: null,
    });
    expect(r.hits).toHaveLength(2);
    expect(await docRows(doc.id)).toBe(1);
    expect((await row(c)).retention_until).toBe(before.retention_until);
    expect(await purged(c)).toEqual([]);
  });

  it("the date clear never arrived AND the re-read comes back empty: never 'purged meanwhile' — the record to write is named", async () => {
    const { c } = await retained();
    const clearOrReread = (m: string, url: string) =>
      (m === "PATCH" && url.includes("/rest/v1/contacts?")) || (m === "GET" && url.includes("/rest/v1/contacts?select=retention_until"));
    const r = await run("purge", c, { on: "admin", hollow: hollow(clearOrReread, "200 empty", { forward: false, times: 2 }) });
    expect(r.result).toEqual({
      error:
        "The 1 retained file(s) and their records are destroyed, but the retention date could not be cleared: the retention date (re-read after an unconfirmed clear): the answer held no rows (HTTP 200). Nothing is left to destroy — do not run the purge again (it would record 0 destroyed): the record (retention_purged, 1 documents, retention until 2020-06-01) must be written by an administrator.",
      purgedAt: null,
    });
    expect(r.hits).toHaveLength(2);
    expect(await purged(c)).toEqual([]);
  });

  it("the date clear landed, its answer lost: the purge reads the date gone and records 1 destroyed", async () => {
    const { c, doc } = await retained();
    const r = await run("purge", c, { on: "admin", hollow: hollow(rest("PATCH", "contacts")) });
    expect(r.result).toEqual({ error: null, purgedAt: expect.any(String) });
    expect(r.hits).toHaveLength(1);
    expect(await objectExists(doc.path)).toBe(false);
    expect((await row(c)).retention_until).toBeNull();
    expect(await purged(c)).toEqual(DESTROYED_ONE);
  });

  it("the date clear never arrived once: the purge reads the date still set, clears it again and records 1 destroyed", async () => {
    const { c } = await retained();
    const r = await run("purge", c, { on: "admin", hollow: hollow(rest("PATCH", "contacts"), "500 null", { forward: false }) });
    expect(r.result).toEqual({ error: null, purgedAt: expect.any(String) });
    expect(r.hits).toHaveLength(1);
    expect((await row(c)).retention_until).toBeNull();
    expect(await purged(c)).toEqual(DESTROYED_ONE);
  });

  it("the date clear fails twice: everything irreversible is done — it names the record to write and warns off a re-run", async () => {
    const { c, doc } = await retained();
    vi.mocked(revalidatePath).mockClear();
    const r = await run("purge", c, {
      on: "admin",
      hollow: hollow(rest("PATCH", "contacts"), "500 null", { forward: false, times: 2 }),
    });
    // the destruction happened: the retention list and the contact page show it
    expect(vi.mocked(revalidatePath).mock.calls).toEqual([["/settings/retention"], [`/contacts/${c}`]]);
    expect(r.result).toEqual({
      error:
        "The 1 retained file(s) and their records are destroyed, but the retention date could not be cleared: the retention date: the answer held no rows (HTTP 500). Nothing is left to destroy — do not run the purge again (it would record 0 destroyed): the record (retention_purged, 1 documents, retention until 2020-06-01) must be written by an administrator.",
      purgedAt: null,
    });
    expect(r.hits).toHaveLength(2);
    expect(await objectExists(doc.path)).toBe(false);
    expect(await docRows(doc.id)).toBe(0);
    expect((await row(c)).retention_until).toBe("2020-06-01");
    expect(await purged(c)).toEqual([]);
  });

  it("the control: a genuine zero-row clear — purged meanwhile by someone else — is still 'purged meanwhile', with no record", async () => {
    const { c } = await retained();
    // a concurrent purge clears the date just before this one's clear
    state.adminBefore = async (method, url) => {
      if (method === "PATCH" && url.includes("/rest/v1/contacts?")) {
        await pg.query("update contacts set retention_until = null, kyc = '{}'::jsonb where id = $1", [c]);
      }
    };
    const r = await run("purge", c);
    expect(r.result).toEqual({ error: "This contact's retained records were purged meanwhile — reload the page.", purgedAt: null });
    expect(await purged(c)).toEqual([]);
  });
});
