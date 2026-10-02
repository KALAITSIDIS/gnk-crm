import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ANON_KEY,
  SUPABASE_URL,
  TEST_PASSWORD,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * An erased contact stays erased, and its retention date is the erasure's
 * (T-erasure-lifecycle-guard, migration 0134).
 *
 * THE GAP (reproduced by this file at 0d43711 / 0132 on the local stack,
 * through PostgREST with real aal2 sessions and through the real server
 * actions): contacts_update (0100) restricts ROWS by organisation and
 * role / ownership, never columns, and no trigger binds the erasure state —
 * so an aal2 admin, or the contact's assigned / creating agent, could PATCH
 * an erased contact's `erased_at`, `erased_by`, `retention_until`,
 * `is_archived`, `temperature` and `consent_marketing`: clear the marker and
 * then pass `unarchiveContact`'s conditions, put the retained identity back
 * on the hot-buyer card and into its phone's uniqueness slot, re-enable
 * marketing, or move the retention date so the purge destroys AML records
 * early (or never). A session could also INSERT a contact already "erased",
 * forge the marker on a live contact — after which the real erasure SKIPPED
 * its contact patch and still wrote an `erased` event claiming the profile
 * was cleared — and write a contact `erased` event itself, which the erasure
 * reads as "already complete". And any admin could Delete an erased
 * contact's retained KYC documents through the Documents tab, years before
 * the retention date.
 *
 * THE DESIGN PINNED HERE:
 *  - for a session (authenticated / anon), `erased_at`, `erased_by` and
 *    `retention_until` are never written: an INSERT carries them null, an
 *    UPDATE (PATCH, bulk, or an upsert's update arm) leaves them as they are;
 *  - for a session, an erased contact admits one change only — archiving it
 *    (the repair path for a row unarchived before T-refuse-unarchive-erased);
 *  - a session may not delete an erased contact's documents: only the
 *    retention purge destroys what the retention keeps;
 *  - a session may not write a contact `erased` or `retention_purged` event;
 *  - erasure's document-row delete, contact patch and event, and the purge's
 *    document-row delete, marker update and event, run as the service role
 *    from the server actions, bounded by the caller's organisation and the
 *    contact, after the actions' own checks; a re-run records nothing the row
 *    does not show; the merge refuses an erased contact, at its read and at
 *    its writes.
 *
 * LAYERS, named honestly: "PATCH / upsert / insert" lines go through
 * PostgREST with real sessions; "action" lines call the REAL server action
 * (only Next's request plumbing is stubbed: `createClient` is the session,
 * `createAdminClient` the real service client — optionally wrapped to inject
 * one fault); "dashboard predicate" lines reproduce a page's query, they do
 * not render the page; "pg" lines are postgres connections impersonating a
 * session (PostgREST's own transaction setup) where two writers must
 * interleave deterministically.
 *
 * Throwaway organisations, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);
const ERASED_STAYS_ARCHIVED = "This contact's personal data was erased under GDPR Article 17 — it stays archived.";

type Fault = { events?: boolean; storage?: boolean };
const state = vi.hoisted(() => ({ queue: [] as unknown[], fault: null as null | Fault }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = state.queue.shift();
    if (!c) throw new Error("test harness: no client queued for this action");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return {
    createAdminClient: () => {
      const real = h.serviceClient();
      return state.fault ? withFault(real, state.fault) : real;
    },
  };
});

/**
 * One injected outage on whichever client the action uses for it: an events
 * INSERT that answers an error, or a storage removal that does. Every other
 * call reaches the real stack.
 */
function withFault<T extends object>(real: T, fault: Fault): T {
  return new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "from" && fault.events) {
        return (table: string) =>
          table === "events"
            ? { insert: async () => ({ data: null, error: { message: "injected: the events insert failed" } }) }
            : (value as (t: string) => unknown).call(target, table);
      }
      if (prop === "storage" && fault.storage) {
        const storage = value as { from: (b: string) => { exists: (p: string) => unknown } };
        return {
          from: (bucket: string) => {
            const api = storage.from(bucket);
            return {
              remove: async () => ({ data: null, error: { message: "injected: storage is unavailable" } }),
              exists: (p: string) => api.exists(p),
            };
          },
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

import { eraseContactPersonalData, purgeExpiredRetention } from "@/lib/actions/contact-erasure";
import { deleteContactDocument, uploadContactDocument } from "@/lib/actions/contact-documents";
import { archiveContact, unarchiveContact, updateContactSection } from "@/lib/actions/contacts";
import { mergeContacts } from "@/lib/actions/merge-contacts";
import { savePartyDefaults } from "@/lib/actions/party-defaults";
import { planContactErasure } from "@/lib/services/erasure";
import { CHECK_0131, CHECK_0134, POLICY_0131, REVERT_0134_SQL, readMigration0134 } from "./revert-0134";

let svc: SupabaseClient;
let pg: Client; // postgres: fixtures, verification, impersonated sessions, cleanup
let pg2: Client; // a second connection, for the interleavings
let pg3: Client; // a third, as postgres, that watches pg_stat_activity during them
let admin: TestUser;
let agent: TestUser; // assigned to and creator of every fixture contact
let peer: TestUser; // same organisation, owns nothing
let lm: TestUser; // listing manager
let inactive: TestUser; // an agent assigned to a contact, then deactivated
let inactiveAdmin: TestUser; // an admin, deactivated for the action tests
let otherAdmin: TestUser; // another organisation
let aal1: SupabaseClient; // the admin, signed in again without the second factor
const userIds: string[] = [];
const storagePaths: string[] = [];
let n = 0;

async function session(user: TestUser): Promise<SupabaseClient> {
  const { data } = await user.client.auth.getSession();
  const s = data.session!;
  const c = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(error.message);
  return c;
}

/** A session client, optionally with one injected fault, queued for the next action call. */
async function queue(user: TestUser, fault: Fault | null = null) {
  const c = await session(user);
  state.queue.push(fault ? withFault(c, fault) : c);
}

const phone = () => `+3579${randomInt(1_000_000, 9_999_999)}`;

/** A live contact as the desk keeps one: assigned to and created by `agent`, hot, consenting, profiled. */
async function newContact(over: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  const p = phone();
  const { data, error } = await svc
    .from("contacts")
    .insert({
      org_id: ORG,
      first_name: `ZZErase${n}`,
      last_name: RUN,
      phone_e164: p,
      phone_raw: p,
      email: `zz-erase-${n}-${RUN}@test.local`,
      additional_phones: [phone()],
      telegram_username: `zz${n}${RUN}`,
      has_whatsapp: true,
      languages: ["el", "en"],
      nationality: "GB",
      contact_types: ["buyer"],
      temperature: "hot",
      source_detail: "walk-in",
      psychology: "investor",
      consent_marketing: true,
      consent_at: new Date().toISOString(),
      notes: `Private note ${n} ${RUN}`,
      banking_readiness: { funds_origin_country: "GB" },
      kyc: { passport: { done: true } },
      assigned_agent_id: agent.id,
      created_by: agent.id,
      ...over,
    })
    .select("id")
    .single();
  if (error) throw new Error(`contact fixture: ${error.message}`);
  return data.id as string;
}

/** An AML relationship: a mandate the contact owns, ending on `expiry` (a past date anchors the 5-year clock there). */
async function ownMandate(contactId: string, expiry: string) {
  n += 1;
  const { rows } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id",
    [ORG, `ZZE${RUN}${n}`.toUpperCase()],
  );
  await pg.query(
    `insert into mandates (org_id, property_id, owner_contact_id, status, type, start_date, expiry_date, renewal_reminder_days)
     values ($1, $2, $3, 'expired', 'open', $4::date - 365, $4::date, 30)`,
    [ORG, rows[0]!.id, contactId, expiry],
  );
}

/** A KYC document on the contact: a real object in the `documents` bucket and its row. */
async function kycDocument(contactId: string): Promise<{ id: string; path: string }> {
  const path = `${ORG}/contacts/${contactId}/${randomUUID()}.pdf`;
  const up = await svc.storage.from("documents").upload(path, new Blob(["%PDF-1.4 zz"], { type: "application/pdf" }));
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

async function displayName(id: string): Promise<string> {
  return (await pg.query("select display_name from contacts where id = $1", [id])).rows[0].display_name as string;
}

/**
 * The REAL erasure, as `user`, with the name typed as the dialog asks. A
 * fault is injected on the session AND the service client, so it lands
 * whichever client the step uses.
 */
async function erase(user: TestUser, id: string, fault: Fault | null = null) {
  const name = await displayName(id);
  await queue(user, fault);
  state.fault = fault;
  try {
    return await eraseContactPersonalData(id, name);
  } finally {
    state.fault = null;
  }
}

async function purge(user: TestUser, id: string, fault: Fault | null = null) {
  await queue(user, fault);
  state.fault = fault;
  try {
    return await purgeExpiredRetention(id);
  } finally {
    state.fault = null;
  }
}

type Row = Record<string, unknown>;
/** The whole row but the clock column — "unchanged" means byte-for-byte. */
const row = async (id: string): Promise<Row> =>
  (await pg.query("select to_jsonb(c) - 'updated_at' as r from contacts c where id = $1", [id])).rows[0].r as Row;

const eventCount = async (id: string, type: string) =>
  (
    await pg.query("select count(*)::int as c from events where entity_type = 'contact' and entity_id = $1 and event_type = $2", [
      id,
      type,
    ])
  ).rows[0].c as number;

async function patch(client: SupabaseClient, id: string | string[], body: Row) {
  const q = client.from("contacts").update(body);
  const r = await (Array.isArray(id) ? q.in("id", id) : q.eq("id", id)).select("id");
  return { code: r.error?.code ?? null, message: r.error?.message ?? "", rows: r.data?.length ?? 0 };
}

const REFUSED = { code: "42501", rows: 0 };
/** 0134's three sentences, each naming the columns it refused — which branch answered. */
const RECORD = (cols: string) => `A contact's erasure record is written only by its erasure and the retention purge (contacts.${cols})`;
const FROZEN = (cols: string) => `An erased contact stays as its erasure left it — archiving it is the one change allowed (contacts.${cols})`;
const BORN = (cols: string) => `A contact's erasure record is written only by its erasure (contacts.${cols})`;

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  pg2 = new Client({ connectionString: DB_URL });
  pg3 = new Client({ connectionString: DB_URL });
  await pg.connect();
  await pg2.connect();
  await pg3.connect();
  await ensureTestOrg(svc, ORG, `Erasure lifecycle ${RUN}`, `erasure-lifecycle-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `Erasure lifecycle other ${RUN}`, `erasure-lifecycle-other-${RUN}`);
  // one at a time (parallel TOTP enrolment trips GoTrue), each id kept as soon as it exists
  const user = async (who: string, role: "admin" | "agent" | "listing_manager", org: string) => {
    const u = await createTestUser(svc, `el-${who}-${RUN}@test.local`, role, org);
    userIds.push(u.id);
    return u;
  };
  admin = await user("admin", "admin", ORG);
  agent = await user("agent", "agent", ORG);
  peer = await user("peer", "agent", ORG);
  lm = await user("lm", "listing_manager", ORG);
  inactive = await user("inactive", "agent", ORG);
  inactiveAdmin = await user("inactive-admin", "admin", ORG);
  otherAdmin = await user("other", "admin", OTHER_ORG);
  aal1 = anonClient();
  const signIn = await aal1.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD });
  if (signIn.error) throw new Error(`aal1 sign-in: ${signIn.error.message}`);
}, 120_000);

afterAll(async () => {
  const orgs = [ORG, OTHER_ORG];
  if (storagePaths.length) await svc.storage.from("documents").remove(storagePaths);
  await pg.query("delete from documents where org_id = any($1)", [orgs]);
  await pg.query("delete from tasks where org_id = any($1)", [orgs]);
  await pg.query("delete from mandates where org_id = any($1)", [orgs]);
  await pg.query("delete from properties where org_id = any($1)", [orgs]);
  await pg.query("delete from interaction_notes where org_id = any($1)", [orgs]);
  await pg.query("delete from buyer_requirements where org_id = any($1)", [orgs]);
  await pg.query("delete from leads where org_id = any($1)", [orgs]);
  await pg.query("delete from contacts where org_id = any($1)", [orgs]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  await pg.query("delete from profiles where org_id = any($1)", [orgs]);
  await pg.query("delete from events where org_id = any($1)", [orgs]);
  await pg.query("delete from events_chain_checkpoint where org_id = any($1)", [orgs]);
  await pg.query("delete from chain_checks where org_id = any($1)", [orgs]);
  await pg.query("delete from deal_stages where org_id = any($1)", [orgs]);
  await pg.query("delete from districts where org_id = any($1)", [orgs]);
  await pg.query("delete from organizations where id = any($1)", [orgs]);
  await pg.end();
  await pg2.end();
  await pg3.end();
}, 120_000);

// every action call consumed its client, and no fault outlived its call
afterEach(() => {
  expect(state.queue, "a queued client no action consumed").toEqual([]);
  expect(state.fault).toBeNull();
});

describe("the real erasure: what it leaves behind", () => {
  it("redacts the profile, parks the row archived and inactive, records the erasure once — written as the trusted path, attributed to the admin", async () => {
    const c = await newContact();
    const r = await erase(admin, c);
    expect(r).toEqual({ error: null, erasedAt: expect.any(String) });
    const after = await row(c);
    expect(after).toMatchObject({
      erased_by: admin.id,
      is_archived: true,
      temperature: "inactive",
      consent_marketing: false,
      consent_at: null,
      has_whatsapp: false,
      notes: null,
      psychology: null,
      additional_phones: [],
      retention_until: null, // no AML relationship
      kyc: {},
    });
    expect(after.erased_at).not.toBeNull();
    // identity retained for AML
    expect(after.phone_e164).toMatch(/^\+3579/);
    const ev = await pg.query(
      "select actor_id::text, payload from events where entity_type = 'contact' and entity_id = $1 and event_type = 'erased'",
      [c],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].actor_id).toBe(admin.id);
    expect(ev.rows[0].payload).toMatchObject({ aml_basis: false, retention_until: null, identity_retained: true });
  });

  it("refuses a second erasure, and an agent's", async () => {
    const c = await newContact();
    expect((await erase(admin, c)).error).toBeNull();
    expect(await erase(admin, c)).toEqual({ error: "This contact's personal data has already been erased.", erasedAt: null });
    const d = await newContact();
    expect(await erase(agent, d)).toEqual({ error: "Admins only.", erasedAt: null });
    expect((await row(d)).erased_at).toBeNull();
  });
});

describe("a session cannot reverse a completed erasure (PATCH)", () => {
  for (const who of ["admin", "agent"] as const) {
    it(`${who}: clearing the marker, unarchiving, both at once, re-attributing, re-dating, re-heating, re-consenting — each refused, nothing moves`, async () => {
      const client = (who === "admin" ? admin : agent).client;
      const c = await newContact();
      expect((await erase(admin, c)).error).toBeNull();
      const before = await row(c);
      // the record branch answers for the three record columns, the freeze for everything else
      const attempts: [Row, string][] = [
        [{ erased_at: null }, RECORD("erased_at")],
        [{ is_archived: false }, FROZEN("is_archived")],
        [{ erased_at: null, is_archived: false }, RECORD("erased_at")],
        [{ erased_by: peer.id }, RECORD("erased_by")],
        [{ erased_by: null }, RECORD("erased_by")],
        [{ erased_at: new Date(Date.parse(before.erased_at as string) - 86_400_000).toISOString() }, RECORD("erased_at")],
        [{ retention_until: "2000-01-01" }, RECORD("retention_until")],
        [{ retention_until: "2099-01-01" }, RECORD("retention_until")],
        [{ temperature: "hot" }, FROZEN("temperature")],
        [{ consent_marketing: true, consent_at: new Date().toISOString() }, FROZEN("consent_at, consent_marketing")],
        [{ has_whatsapp: true }, FROZEN("has_whatsapp")],
        [{ notes: "re-entered after erasure" }, FROZEN("notes")],
        [{ phone_e164: phone() }, FROZEN("phone_e164")],
      ];
      for (const [body, sentence] of attempts) {
        const r = await patch(client, c, body);
        expect({ body, code: r.code, rows: r.rows, message: r.message }).toEqual({ body, ...REFUSED, message: sentence });
      }
      expect(await row(c)).toEqual(before);
    });
  }

  it("clearing the marker first, then the normal unarchive action, cannot bring the contact back — for the admin or the assigned agent", async () => {
    for (const user of [admin, agent]) {
      const c = await newContact();
      expect((await erase(admin, c)).error).toBeNull();
      expect(await patch(user.client, c, { erased_at: null })).toEqual({ ...REFUSED, message: RECORD("erased_at") });
      await queue(user);
      expect(await unarchiveContact(c)).toEqual({ error: ERASED_STAYS_ARCHIVED });
      const after = await row(c);
      expect(after.erased_at).not.toBeNull();
      expect(after.is_archived).toBe(true);
      expect(await eventCount(c, "unarchived")).toBe(0);
    }
  });

  it("a bulk PATCH naming an erased contact and an ordinary archived one is refused as a whole — no partial change", async () => {
    const erased = await newContact();
    expect((await erase(admin, erased)).error).toBeNull();
    const archived = await newContact({ is_archived: true });
    const r = await patch(admin.client, [erased, archived], { is_archived: false });
    expect(r).toEqual({ ...REFUSED, message: FROZEN("is_archived") });
    expect((await row(archived)).is_archived).toBe(true);
    expect((await row(erased)).is_archived).toBe(true);
  });

  it("an upsert onto the erased contact's id (its update arm) is refused the same way", async () => {
    const c = await newContact();
    expect((await erase(admin, c)).error).toBeNull();
    const before = await row(c);
    for (const user of [admin, agent]) {
      const r = await user.client
        .from("contacts")
        .upsert({ id: c, org_id: ORG, first_name: "ZZ upserted", erased_at: null, is_archived: false }, { onConflict: "id" })
        .select("id");
      // the insert arm passes (the proposed row carries no record); the update arm answers
      expect({ code: r.error?.code, message: r.error?.message }).toEqual({ code: "42501", message: RECORD("erased_at") });
      const r2 = await user.client
        .from("contacts")
        .upsert({ id: c, org_id: ORG, first_name: "ZZ upserted", is_archived: false }, { onConflict: "id" })
        .select("id");
      expect({ code: r2.error?.code, message: r2.error?.message }).toEqual({ code: "42501", message: FROZEN("first_name, is_archived") });
    }
    expect(await row(c)).toEqual(before);
  });

  it("the archive repair stays open: an erased contact left active (a state written before T-refuse-unarchive-erased) can be archived — and then not unarchived", async () => {
    const c = await newContact();
    expect((await erase(admin, c)).error).toBeNull();
    await pg.query("update contacts set is_archived = false where id = $1", [c]); // the legacy state, as postgres
    await queue(agent);
    expect(await archiveContact(c)).toEqual({ error: null });
    expect((await row(c)).is_archived).toBe(true);
    expect(await patch(agent.client, c, { is_archived: false })).toEqual({ ...REFUSED, message: FROZEN("is_archived") });
  });

  it("the erased contact never re-enters the hot-buyer card, and its phone's active slot stays free", async () => {
    const c = await newContact();
    expect((await erase(admin, c)).error).toBeNull();
    // the attempts the audit chained, each refused
    expect(await patch(agent.client, c, { erased_at: null })).toEqual({ ...REFUSED, message: RECORD("erased_at") });
    expect(await patch(agent.client, c, { is_archived: false, temperature: "hot" })).toEqual({
      ...REFUSED,
      message: FROZEN("is_archived, temperature"),
    });
    // dashboard predicate (components/features/dashboard/agent-dashboard.tsx — hot buyers), reproduced on the agent's session
    const hot = await agent.client
      .from("contacts")
      .select("id")
      .eq("temperature", "hot")
      .contains("contact_types", ["buyer"])
      .eq("is_archived", false)
      .eq("id", c);
    expect(hot.error).toBeNull();
    expect(hot.data).toEqual([]);
    // a new contact may take the retained phone: the erased row holds no active slot
    const retained = (await row(c)).phone_e164 as string;
    const fresh = await agent.client
      .from("contacts")
      .insert({ org_id: ORG, first_name: "ZZ new owner", phone_e164: retained, created_by: agent.id, assigned_agent_id: agent.id })
      .select("id");
    expect(fresh.error).toBeNull();
    expect(fresh.data).toHaveLength(1);
  });
});

describe("retention is the erasure's to set and the purge's to clear", () => {
  it("a retained contact's date cannot be moved to unlock the purge early, or cleared to keep the files for ever", async () => {
    const c = await newContact();
    await ownMandate(c, new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)); // relationship still running
    const doc = await kycDocument(c);
    expect((await erase(admin, c)).error).toBeNull();
    const before = await row(c);
    expect(before.retention_until).not.toBeNull();
    expect(await patch(admin.client, c, { retention_until: "2000-01-01" })).toEqual({ ...REFUSED, message: RECORD("retention_until") });
    expect(await patch(agent.client, c, { retention_until: null })).toEqual({ ...REFUSED, message: RECORD("retention_until") });
    // the purge still refuses on the erasure's own date, and the retained file is still there
    const p = await purge(admin, c);
    expect(p.purgedAt).toBeNull();
    expect(p.error).toMatch(/^Retention runs until /);
    expect(await objectExists(doc.path)).toBe(true);
    expect((await pg.query("select count(*)::int as c from documents where id = $1", [doc.id])).rows[0].c).toBe(1);
    expect(await row(c)).toEqual(before);
  });

  it("on a contact that was never erased, a session cannot set a retention date or an eraser either — the record check, not the freeze, refuses", async () => {
    const c = await newContact();
    const before = await row(c);
    for (const user of [admin, agent]) {
      for (const [body, column] of [
        [{ retention_until: "2020-01-01" }, "retention_until"],
        [{ erased_by: admin.id }, "erased_by"],
        [{ erased_at: new Date().toISOString() }, "erased_at"],
      ] as const) {
        const r = await patch(user.client, c, body);
        expect({ body, code: r.code, rows: r.rows, message: r.message }).toEqual({ body, ...REFUSED, message: RECORD(column) });
      }
    }
    expect(await row(c)).toEqual(before);
  });

  it("the purge works when the duty has run: files and rows destroyed, marker cleared by the trusted path, erasure record kept, one event", async () => {
    const c = await newContact();
    await ownMandate(c, "2015-06-01"); // anchor 2015 → retention 2020: already lapsed
    const doc = await kycDocument(c);
    expect((await erase(admin, c)).error).toBeNull();
    const erased = await row(c);
    expect(erased.retention_until).toBe("2020-06-01");
    expect(await purge(agent, c)).toEqual({ error: "Admins only.", purgedAt: null });
    const r = await purge(admin, c);
    expect(r).toEqual({ error: null, purgedAt: expect.any(String) });
    expect(await objectExists(doc.path)).toBe(false);
    expect((await pg.query("select count(*)::int as c from documents where id = $1", [doc.id])).rows[0].c).toBe(0);
    const after = await row(c);
    expect(after).toMatchObject({ retention_until: null, kyc: {}, erased_at: erased.erased_at, erased_by: admin.id, is_archived: true });
    const ev = await pg.query(
      "select actor_id::text, payload from events where entity_type = 'contact' and entity_id = $1 and event_type = 'retention_purged'",
      [c],
    );
    expect(ev.rows).toEqual([{ actor_id: admin.id, payload: { documents_destroyed: 1, retention_until: "2020-06-01" } }]);
    expect(await purge(admin, c)).toEqual({ error: "Nothing is retained for this contact.", purgedAt: null });
  });

  it("a storage outage during the purge changes nothing, and the purge then finishes", async () => {
    const c = await newContact();
    await ownMandate(c, "2015-06-01");
    const doc = await kycDocument(c);
    expect((await erase(admin, c)).error).toBeNull();
    const before = await row(c);
    const failed = await purge(admin, c, { storage: true });
    expect(failed.purgedAt).toBeNull();
    expect(failed.error).toMatch(/^The retained files were NOT destroyed: .*injected: storage is unavailable.*Nothing was changed/);
    expect(await objectExists(doc.path)).toBe(true);
    expect(await row(c)).toEqual(before);
    expect(await eventCount(c, "retention_purged")).toBe(0);
    expect((await purge(admin, c)).error).toBeNull();
    expect(await objectExists(doc.path)).toBe(false);
    expect(await eventCount(c, "retention_purged")).toBe(1);
  });

  it("action: a purge that finds a file already gone (a half-finished earlier run) still finishes and records it — storage's answer for an absent object is absent", async () => {
    const c = await newContact();
    await ownMandate(c, "2015-06-01");
    const doc = await kycDocument(c);
    expect((await erase(admin, c)).error).toBeNull();
    await svc.storage.from("documents").remove([doc.path]); // what an earlier purge refused at its row delete left behind
    expect(await objectExists(doc.path)).toBe(false);
    expect(await purge(admin, c)).toEqual({ error: null, purgedAt: expect.any(String) });
    expect((await pg.query("select count(*)::int as c from documents where id = $1", [doc.id])).rows[0].c).toBe(0);
    const ev = await pg.query("select payload from events where entity_type = 'contact' and entity_id = $1 and event_type = 'retention_purged'", [c]);
    expect(ev.rows).toEqual([{ payload: { documents_destroyed: 1, retention_until: "2020-06-01" } }]);
  });

  it("action: a purge whose record fails to write says so in a sentence — the files and the date are gone, the record is not", async () => {
    const c = await newContact();
    await ownMandate(c, "2015-06-01");
    const doc = await kycDocument(c);
    expect((await erase(admin, c)).error).toBeNull();
    const r = await purge(admin, c, { events: true });
    expect(r.purgedAt).toEqual(expect.any(String));
    expect(r.error).toMatch(
      /^Purged — 1 retained file\(s\) and the retention date are gone — but the record of it failed to write: .*injected: the events insert failed.*must be written by an administrator\.$/,
    );
    expect(await objectExists(doc.path)).toBe(false);
    expect((await row(c)).retention_until).toBeNull();
    expect(await eventCount(c, "retention_purged")).toBe(0);
  });
});

describe("a session cannot fabricate the lifecycle (INSERT and UPSERT)", () => {
  it("an insert carrying erased_at, erased_by or retention_until is refused for every role that may insert", async () => {
    for (const user of [admin, agent, lm]) {
      for (const extra of [
        { erased_at: new Date().toISOString(), is_archived: true },
        { erased_by: admin.id },
        { retention_until: "2031-01-01" },
      ]) {
        const r = await user.client
          .from("contacts")
          .insert({ org_id: ORG, first_name: `ZZ fabricated ${RUN}`, created_by: user.id, ...extra })
          .select("id");
        const column = Object.keys(extra).find((k) => k !== "is_archived")!;
        expect({ extra, code: r.error?.code ?? null, message: r.error?.message }).toEqual({ extra, code: "42501", message: BORN(column) });
      }
    }
    const made = await pg.query("select count(*)::int as c from contacts where org_id = $1 and first_name = $2", [
      ORG,
      `ZZ fabricated ${RUN}`,
    ]);
    expect(made.rows[0].c).toBe(0);
  });

  it("an upsert's insert arm is refused the same way; an ordinary insert and upsert still work", async () => {
    const id = randomUUID();
    const r = await admin.client
      .from("contacts")
      .upsert({ id, org_id: ORG, first_name: "ZZ upsert-born", erased_at: new Date().toISOString() }, { onConflict: "id" })
      .select("id");
    expect({ code: r.error?.code, message: r.error?.message }).toEqual({ code: "42501", message: BORN("erased_at") });
    const ok = await admin.client.from("contacts").upsert({ id, org_id: ORG, first_name: "ZZ upsert-born" }, { onConflict: "id" }).select("id");
    expect(ok.error).toBeNull();
    expect(ok.data).toEqual([{ id }]);
  });
});

describe("the erasure marker and record are proof the erasure can trust", () => {
  it("a session cannot forge the marker on a live contact — so the erasure that follows performs the whole redaction", async () => {
    for (const user of [admin, agent]) {
      const c = await newContact();
      expect(await patch(user.client, c, { erased_at: new Date().toISOString() })).toEqual({ ...REFUSED, message: RECORD("erased_at") });
      expect(await patch(user.client, c, { erased_at: new Date().toISOString(), erased_by: admin.id, is_archived: true })).toEqual({
        ...REFUSED,
        message: RECORD("erased_at, erased_by"),
      });
      expect((await row(c)).erased_at).toBeNull();
      expect((await erase(admin, c)).error).toBeNull();
      expect(await row(c)).toMatchObject({ notes: null, consent_marketing: false, temperature: "inactive", is_archived: true, erased_by: admin.id });
    }
  });

  it("action: a marker forged BEFORE 0134 (planted as postgres) is not recorded as an erasure — the re-run refuses, nothing moves", async () => {
    const c = await newContact();
    await pg.query("update contacts set erased_at = now() where id = $1", [c]); // what a session could write at 0132
    const before = await row(c);
    const r = await erase(admin, c);
    expect(r.erasedAt).toBeNull();
    expect(r.error).toMatch(
      /^This contact is marked erased, but it still holds what the erasure clears \(.*consent_marketing.*notes.*temperature.*\), so the erasure will not be recorded as done\. Nothing was changed/,
    );
    expect(await row(c)).toEqual(before);
    expect(await eventCount(c, "erased")).toBe(0);
  });

  it("a session cannot write a contact's `erased` or `retention_purged` event; other contact events stay writable", async () => {
    const c = await newContact();
    for (const user of [admin, agent]) {
      for (const type of ["erased", "retention_purged"]) {
        const r = await user.client
          .from("events")
          .insert({ org_id: ORG, actor_id: user.id, entity_type: "contact", entity_id: c, event_type: type, payload: {} });
        expect({ user: user.email, type, code: r.error?.code ?? null }).toEqual({ user: user.email, type, code: "42501" });
        expect(r.error?.message).toBe('new row violates row-level security policy for table "events"');
      }
    }
    expect(await eventCount(c, "erased")).toBe(0);
    const ok = await agent.client
      .from("events")
      .insert({ org_id: ORG, actor_id: agent.id, entity_type: "contact", entity_id: c, event_type: "conversation_logged", payload: { channel: "phone" } });
    expect(ok.error).toBeNull();
  });

  it("an erasure interrupted by a storage outage stops before the marker, and a re-run finishes it", async () => {
    const c = await newContact();
    const doc = await kycDocument(c); // no AML basis: the file must go
    const first = await erase(admin, c, { storage: true });
    expect(first.erasedAt).toBeNull();
    expect(first.error).toMatch(/^Erasure stopped while removing document files: .*injected: storage is unavailable.*run it again to finish/);
    expect((await row(c)).erased_at).toBeNull();
    expect(await objectExists(doc.path)).toBe(true);
    const second = await erase(admin, c);
    expect(second).toEqual({ error: null, erasedAt: expect.any(String) });
    expect(await objectExists(doc.path)).toBe(false);
    expect(await eventCount(c, "erased")).toBe(1);
  });

  it("an erasure whose record failed to write is finished by a re-run — a forged record in between is refused, so it cannot pass for the real one", async () => {
    const c = await newContact();
    const first = await erase(admin, c, { events: true });
    expect(first.error).toMatch(/^Erased, but the record of it failed to write: .*injected: the events insert failed/);
    expect(first.erasedAt).not.toBeNull();
    const half = await row(c);
    expect(half).toMatchObject({ is_archived: true, notes: null, consent_marketing: false, erased_by: admin.id });
    expect(await eventCount(c, "erased")).toBe(0);
    const forged = await agent.client
      .from("events")
      .insert({ org_id: ORG, actor_id: agent.id, entity_type: "contact", entity_id: c, event_type: "erased", payload: { aml_basis: false } });
    expect(forged.error?.code).toBe("42501");
    const second = await erase(admin, c);
    expect(second).toEqual({ error: null, erasedAt: half.erased_at });
    const ev = await pg.query("select actor_id::text from events where entity_type = 'contact' and entity_id = $1 and event_type = 'erased'", [c]);
    expect(ev.rows).toEqual([{ actor_id: admin.id }]);
    expect(await row(c)).toEqual(half);
  });

  it("action: the erasure deletes only the document rows it listed — another organisation's row naming the contact survives", async () => {
    const c = await newContact();
    const planted = (
      await pg.query<{ id: string }>(
        `insert into documents (org_id, entity_type, entity_id, doc_type, title, storage_path)
         values ($1, 'contact', $2, 'other', 'ZZ planted', $3) returning id`,
        [OTHER_ORG, c, `${OTHER_ORG}/contacts/${c}/planted.pdf`],
      )
    ).rows[0]!.id;
    expect((await erase(admin, c)).error).toBeNull();
    expect((await pg.query("select count(*)::int as c from documents where id = $1", [planted])).rows[0].c).toBe(1);
  });
});

describe("an erased contact's retained documents are destroyed only by the retention purge", () => {
  it("a session's DELETE of one is refused, and so is the real Delete; a live contact's document still deletes", async () => {
    const c = await newContact();
    await ownMandate(c, new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
    const doc = await kycDocument(c);
    expect((await erase(admin, c)).error).toBeNull();
    // PostgREST, the admin's session (documents_delete admits admins only)
    const direct = await admin.client.from("documents").delete().eq("id", doc.id).select("id");
    expect(direct.error?.code).toBe("42501");
    expect(direct.error?.message).toBe(`An erased contact's retained documents are kept until the retention purge destroys them (documents.${doc.id})`);
    for (const user of [agent, lm]) {
      // RLS: not theirs to delete at all — filtered, no error (documents_delete admits admins only)
      const r = await user.client.from("documents").delete().eq("id", doc.id).select("id");
      expect({ error: r.error, data: r.data }).toEqual({ error: null, data: [] });
    }
    // the real action, as the admin
    await queue(admin);
    expect(await deleteContactDocument(doc.id, c)).toEqual({
      error:
        "This contact's personal data was erased — its retained documents are destroyed only by the retention purge (Settings → Retention), once the AML retention period has run.",
    });
    expect((await pg.query("select count(*)::int as c from documents where id = $1", [doc.id])).rows[0].c).toBe(1);
    expect(await objectExists(doc.path)).toBe(true);
    expect(await eventCount(c, "document_deleted")).toBe(0);
    // control: a contact that was never erased
    const live = await newContact();
    const liveDoc = await kycDocument(live);
    await queue(admin);
    expect(await deleteContactDocument(liveDoc.id, live)).toEqual({ error: null });
    expect((await pg.query("select count(*)::int as c from documents where id = $1", [liveDoc.id])).rows[0].c).toBe(0);
    expect(await objectExists(liveDoc.path)).toBe(false);
  });

  it("a document on an erased contact WITHOUT a retention date is under no duty and stays deletable; the upload action takes none", async () => {
    const c = await newContact(); // no AML relationship: nothing retained
    expect((await erase(admin, c)).error).toBeNull();
    expect((await row(c)).retention_until).toBeNull();
    const later = await kycDocument(c); // attached since, as the service role (an evidence report, a legacy row)
    const del = await admin.client.from("documents").delete().eq("id", later.id).select("id");
    expect({ error: del.error, data: del.data }).toEqual({ error: null, data: [{ id: later.id }] });
    const fd = new FormData();
    fd.set("contact_id", c);
    fd.set("doc_type", "other");
    fd.set("file", new File(["%PDF-1.4 zz"], "late.pdf", { type: "application/pdf" }));
    await queue(admin);
    expect(await uploadContactDocument({ error: null, savedAt: null }, fd)).toEqual({
      error: "This contact's personal data was erased — no new documents may be added.",
      savedAt: null,
    });
  });
});

describe("the callers RLS already refuses stay refused, and nothing moves", () => {
  it("a peer agent, a listing manager, a deactivated assignee, another organisation's admin, an aal1 session, anon", async () => {
    const c = await newContact({ assigned_agent_id: inactive.id, created_by: inactive.id });
    expect((await erase(admin, c)).error).toBeNull();
    const before = await row(c);
    await svc.from("profiles").update({ is_active: false }).eq("id", inactive.id);
    try {
      // RLS filters the row for these — no error, nothing matched; the guard never sees it
      for (const client of [peer.client, lm.client, inactive.client, otherAdmin.client, aal1]) {
        expect(await patch(client, c, { erased_at: null, is_archived: false })).toEqual({ code: null, message: "", rows: 0 });
      }
      // anon holds no grant on contacts at all (0002)
      const anon = await patch(anonClient(), c, { erased_at: null, is_archived: false });
      expect({ code: anon.code, rows: anon.rows }).toEqual({ code: "42501", rows: 0 });
      expect(anon.message).toMatch(/permission denied for table contacts/);
      expect(await row(c)).toEqual(before);
    } finally {
      await svc.from("profiles").update({ is_active: true }).eq("id", inactive.id);
    }
  });

  it("action: another organisation's admin, a listing manager, an agent, a deactivated admin and an aal1 session cannot run the erasure or the purge", async () => {
    const c = await newContact();
    expect(await erase(otherAdmin, c)).toEqual({ error: "Contact not found", erasedAt: null });
    expect(await purge(otherAdmin, c)).toEqual({ error: "Contact not found", purgedAt: null });
    for (const user of [lm, agent]) {
      expect(await erase(user, c)).toEqual({ error: "Admins only.", erasedAt: null });
      expect(await purge(user, c)).toEqual({ error: "Admins only.", purgedAt: null });
    }
    await pg.query("update profiles set is_active = false where id = $1", [inactiveAdmin.id]);
    try {
      await expect(erase(inactiveAdmin, c)).rejects.toThrow(/Profile not found|Account deactivated/);
      await expect(purge(inactiveAdmin, c)).rejects.toThrow(/Profile not found|Account deactivated/);
    } finally {
      await pg.query("update profiles set is_active = true where id = $1", [inactiveAdmin.id]);
    }
    state.queue.push(aal1);
    await expect(eraseContactPersonalData(c, await displayName(c))).rejects.toThrow(/Profile not found/);
    state.queue.push(aal1);
    await expect(purgeExpiredRetention(c)).rejects.toThrow(/Profile not found/);
    expect((await row(c)).erased_at).toBeNull();
    expect(await eventCount(c, "erased")).toBe(0);
  });

  it("action: the purge refuses a retention date on a contact that was never erased (a state only a trusted-path write can leave now)", async () => {
    const c = await newContact({ retention_until: "2020-01-01" }); // as the service role: the legacy / maintenance state
    const doc = await kycDocument(c);
    const before = await row(c);
    expect(await purge(admin, c)).toEqual({ error: "This contact was not erased — there is no retention duty to purge.", purgedAt: null });
    expect(await objectExists(doc.path)).toBe(true);
    expect(await row(c)).toEqual(before);
  });
});

describe("ordinary work is unchanged", () => {
  it("action: the assigned agent edits a live contact through the real profile action, and archives and unarchives it", async () => {
    const c = await newContact({ temperature: "warm", consent_marketing: false, consent_at: null });
    const fd = new FormData();
    fd.set("contact_id", c);
    fd.set("section", "profile");
    fd.set("first_name", "ZZEdited");
    fd.set("last_name", RUN);
    fd.set("temperature", "hot");
    fd.set("consent_marketing", "on");
    fd.set("notes", "Edited by the agent");
    await queue(agent);
    expect(await updateContactSection({ error: null, savedAt: null }, fd)).toMatchObject({ error: null });
    expect(await row(c)).toMatchObject({ first_name: "ZZEdited", temperature: "hot", consent_marketing: true, notes: "Edited by the agent" });
    await queue(agent);
    expect(await archiveContact(c)).toEqual({ error: null });
    await queue(agent);
    expect(await unarchiveContact(c)).toEqual({ error: null });
    expect((await row(c)).is_archived).toBe(false);
    expect(await eventCount(c, "unarchived")).toBe(1);
  });

  it("a direct PATCH of ordinary fields, restating the lifecycle columns, still works; the primary key stays immutable (0132)", async () => {
    const c = await newContact();
    expect(await patch(agent.client, c, { notes: "ZZ plain edit", temperature: "warm" })).toEqual({ code: null, message: "", rows: 1 });
    expect(await patch(admin.client, c, { erased_at: null, erased_by: null, retention_until: null, is_archived: false })).toEqual({
      code: null,
      message: "",
      rows: 1,
    });
    const rekey = await patch(admin.client, c, { id: randomUUID() });
    expect(rekey.code).toBe("42501");
    expect(rekey.message).toMatch(/primary key cannot be changed \(contacts\.id\)/);
  });
});

describe("concurrent writers cannot undo a completed erasure (pg, deterministic interleavings)", () => {
  async function asSessionOn(c: Client, uid: string) {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" })]);
  }
  /** The erasure's contact patch exactly as the action plans it, written as the service role. */
  function patchSql(contactId: string) {
    const { patch: p } = planContactErasure({ amlBasis: false, actorId: admin.id, now: new Date().toISOString(), relationshipEndCandidates: [] });
    const cols = Object.keys(p);
    return {
      text: `update contacts set (${cols.join(", ")}) = (select ${cols.map((k) => `r.${k}`).join(", ")}
               from jsonb_populate_record(null::public.contacts, $1::jsonb) r)
             where org_id = $2 and id = $3 and erased_at is null`,
      values: [JSON.stringify(p), ORG, contactId],
    };
  }

  /** Poll until `client`'s backend is waiting on a lock — the interleaving really happened. */
  async function waitingOnLock(client: Client) {
    const pid = (client as unknown as { processID: number }).processID;
    for (let i = 0; i < 100; i++) {
      const r = await pg3.query<{ w: string | null }>("select wait_event_type as w from pg_stat_activity where pid = $1", [pid]);
      if (r.rows[0]?.w === "Lock") return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`backend ${pid} never waited on a lock`);
  }
  /** End whatever transaction a failed assertion left open, so cleanup is never blocked or discarded. */
  async function endBoth() {
    await pg.query("rollback").catch(() => {});
    await pg2.query("rollback").catch(() => {});
  }

  it("an agent's edit or unarchive that waits on the erasure's row lock is refused once the erasure commits", async () => {
    for (const [body, sentence] of [
      ["notes = 'stale edit', temperature = 'hot'", FROZEN("notes, temperature")],
      ["is_archived = false", FROZEN("is_archived")],
      ["consent_marketing = true", FROZEN("consent_marketing")],
    ] as const) {
      const c = await newContact();
      try {
        await pg.query("begin");
        await pg.query("set local role service_role");
        const p = patchSql(c);
        expect((await pg.query(p.text, p.values)).rowCount).toBe(1);
        await pg2.query("begin");
        await asSessionOn(pg2, agent.id);
        const waiting = pg2.query(`update contacts set ${body} where id = $1`, [c]).then(
          (r) => ({ ok: true as const, rows: r.rowCount, code: null as string | null, message: "" }),
          (e: { code?: string; message?: string }) => ({ ok: false as const, rows: 0, code: e.code ?? null, message: e.message ?? "" }),
        );
        await waitingOnLock(pg2); // blocked on the erasure's row lock, not merely sent late
        await pg.query("commit");
        const result = await waiting;
        await pg2.query("rollback");
        expect({ body, ...result }).toEqual({ body, ok: false, rows: 0, code: "42501", message: sentence });
      } finally {
        await endBoth();
      }
      expect(await row(c)).toMatchObject({ is_archived: true, notes: null, temperature: "inactive", consent_marketing: false });
    }
  });

  it("an agent's edit that commits first is overwritten by the erasure that waited on it", async () => {
    const c = await newContact();
    try {
      await pg2.query("begin");
      await asSessionOn(pg2, agent.id);
      expect((await pg2.query("update contacts set notes = 'late note', temperature = 'hot' where id = $1", [c])).rowCount).toBe(1);
      await pg.query("begin");
      await pg.query("set local role service_role");
      const p = patchSql(c);
      const erasing = pg.query(p.text, p.values);
      await waitingOnLock(pg);
      await pg2.query("commit");
      expect((await erasing).rowCount).toBe(1);
      await pg.query("commit");
    } finally {
      await endBoth();
    }
    expect(await row(c)).toMatchObject({ notes: null, temperature: "inactive", is_archived: true });
  });
});

describe("the other writers of an erased contact refuse it themselves (actions)", () => {
  it("action: the merge refuses an erased contact on either side — active, archived, or as a merge being resumed — and moves nothing", async () => {
    const live = await newContact();
    // erased contacts left ACTIVE (the legacy state, as postgres) and one parked by a half-finished merge into `live`
    const erasedPrimary = await newContact();
    const erasedDuplicate = await newContact();
    const resumed = await newContact();
    for (const c of [erasedPrimary, erasedDuplicate, resumed]) expect((await erase(admin, c)).error).toBeNull();
    await pg.query("update contacts set is_archived = false where id = any($1::uuid[])", [[erasedPrimary, erasedDuplicate]]);
    await pg.query("update contacts set merged_into_id = $1 where id = $2", [live, resumed]);
    const snapshot = async () => {
      const rows: Row[] = [];
      for (const id of [live, erasedPrimary, erasedDuplicate, resumed]) rows.push(await row(id)); // one pg client: one query at a time
      return rows;
    };
    const before = await snapshot();
    for (const [primary, duplicate] of [
      [erasedPrimary, live],
      [live, erasedDuplicate],
      [live, resumed],
    ]) {
      const fd = new FormData();
      fd.set("primary_id", primary!);
      fd.set("duplicate_id", duplicate!);
      await queue(admin);
      expect(await mergeContacts({ error: null, mergedAt: null }, fd)).toEqual({
        error: "An erased contact cannot be merged — its personal data was erased under GDPR Article 17.",
        mergedAt: null,
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("action: the admin's standard terms and the profile editor refuse an erased contact themselves; the row and its events stay as they were", async () => {
    const c = await newContact({ contact_types: ["owner"] });
    expect((await erase(admin, c)).error).toBeNull();
    const before = await row(c);
    const updated = await eventCount(c, "updated");
    const terms = new FormData();
    terms.set("contact_id", c);
    terms.set("commission_pct", "3");
    await queue(admin);
    expect(await savePartyDefaults({ error: null, savedAt: null }, terms)).toEqual({
      error: "This contact's personal data was erased under GDPR Article 17 — it cannot be edited.",
      savedAt: null,
    });
    // …and the database says the same to a direct write of it
    expect(await patch(admin.client, c, { party_defaults: { commission_pct: 3 } })).toEqual({ ...REFUSED, message: FROZEN("party_defaults") });
    // the legacy erased-but-active row: archived no longer stands in front of the editor
    await pg.query("update contacts set is_archived = false where id = $1", [c]);
    const fd = new FormData();
    fd.set("contact_id", c);
    fd.set("section", "profile");
    fd.set("first_name", "ZZ re-entered");
    await queue(admin);
    expect(await updateContactSection({ error: null, savedAt: null }, fd)).toEqual({
      error: "This contact's personal data was erased under GDPR Article 17 — it cannot be edited.",
      savedAt: null,
    });
    expect(await row(c)).toEqual({ ...before, is_archived: false });
    expect(await eventCount(c, "updated")).toBe(updated);
  });
});

describe("0134 itself: replay over 0132, refusals, rollback, restore pack, trusted paths (pg, rolled back)", () => {
  async function rolledBack(body: (notices: string[]) => Promise<void>) {
    const notices: string[] = [];
    const onNotice = (m: { message?: string }) => notices.push(m.message ?? "");
    pg.on("notice", onNotice);
    await pg.query("begin");
    await pg.query("set local lock_timeout = '5s'");
    try {
      await body(notices);
    } finally {
      await pg.query("rollback");
      pg.off("notice", onNotice);
    }
  }
  const insertCheck = async () =>
    (
      await pg.query<{ c: string }>(
        `select pg_get_expr(polwithcheck, polrelid) as c from pg_policy where polrelid = 'public.events'::regclass and polname = 'events_insert'`,
      )
    ).rows[0]!.c;
  /** Both 0134 triggers present (true), both absent (false); one without the other is a failure. */
  const guardExists = async () => {
    const n = (
      await pg.query<{ n: number }>(
        `select count(*)::int as n from pg_trigger
          where (tgrelid = 'public.contacts'::regclass and tgname = 'contacts_retain_erasure')
             or (tgrelid = 'public.documents'::regclass and tgname = 'documents_kept_for_retention')`,
      )
    ).rows[0]!.n;
    if (n === 1) throw new Error("one 0134 trigger without the other");
    return n === 2;
  };
  async function asSession(uid: string) {
    await pg.query("set local role authenticated");
    await pg.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" })]);
  }

  it("over the rollback's 0132 state, the preflight and postflight pass, the existing rows are reported, and nothing existing is rewritten", async () => {
    await rolledBack(async (notices) => {
      await pg.query(`set local search_path = "$user", public, extensions`);
      await pg.query(REVERT_0134_SQL);
      expect(await insertCheck()).toBe(CHECK_0131);
      expect(await guardExists()).toBe(false);
      const maxBefore = (await pg.query<{ m: string }>("select coalesce(max(id), 0)::text as m from events")).rows[0]!.m;
      const eventsDigest = `select md5(coalesce(string_agg(id::text || ':' || coalesce(hash, '') || ':' || payload::text, '|' order by id), '')) as d from events where id <= $1::bigint`;
      const contactsDigest = "select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by id), '')) as d from contacts c";
      const ev = (await pg.query<{ d: string }>(eventsDigest, [maxBefore])).rows[0]!.d;
      const co = (await pg.query<{ d: string }>(contactsDigest)).rows[0]!.d;

      const results = [await pg.query(readMigration0134())].flat();
      expect(notices.some((m) => m.startsWith("0134: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0134: postflight passed"))).toBe(true);
      expect(
        notices.some((m) =>
          /^0134: existing rows \(read-only, nothing repaired\) — erased_but_active=\d+ erased_unredacted=\d+ erased_without_eraser=\d+ retained_not_erased=\d+ erased_documents_unretained=\d+ erased_without_record=\d+ record_without_erasure=\d+ boundary=\d+$/.test(m),
        ),
        notices.join("\n"),
      ).toBe(true);
      const last = results[results.length - 1] as { rows: Array<{ existing_rows: string; enforcement_boundary: string }> };
      expect(last.rows[0]!.existing_rows).toMatch(/^0134 applied — existing rows .*record_without_erasure=\d+ boundary=\d+$/);
      // the boundary is exact (read under events' lock) and kept on the trigger
      const maxNow = (await pg.query<{ m: string }>("select coalesce(max(id), 0)::text as m from events")).rows[0]!.m;
      expect(last.rows[0]!.existing_rows).toContain(`boundary=${maxNow}`);
      const comment = (
        await pg.query<{ c: string }>(
          "select obj_description(oid, 'pg_trigger') as c from pg_trigger where tgrelid = 'public.contacts'::regclass and tgname = 'contacts_retain_erasure'",
        )
      ).rows[0]!.c;
      expect(comment).toMatch(new RegExp(`^0134 enforcement boundary: from event id > ${maxNow} no session may write`));
      expect(last.rows[0]!.enforcement_boundary, "the last row carries the comment as written").toBe(comment);
      expect(await insertCheck()).toBe(CHECK_0134);
      expect(await guardExists()).toBe(true);
      expect((await pg.query<{ d: string }>(eventsDigest, [maxBefore])).rows[0]!.d).toBe(ev);
      expect((await pg.query<{ d: string }>(contactsDigest)).rows[0]!.d).toBe(co);
    });
  });

  it("the file refuses before it changes anything, takes contacts' lock first and alters events_insert last", () => {
    const sql = readMigration0134().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.indexOf("0134 aborted"), "every refusal sits in the preflight, before the first change").toBeGreaterThan(0);
    expect(sql.lastIndexOf("0134 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("lock table public.contacts")).toBeLessThan(firstChange);
    expect(sql.indexOf("create trigger contacts_retain_erasure"), "contacts' lock before events'").toBeLessThan(
      sql.indexOf("alter policy events_insert"),
    );
    const afterPolicy = sql.slice(sql.indexOf("alter policy events_insert") + "alter policy".length);
    expect(afterPolicy.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im), "events' lock is the file's last DDL").toBe(-1);
    // …but for the boundary comment, written by EXECUTE on contacts, whose lock the preflight already holds
    expect([...afterPolicy.matchAll(/execute\s+format\('\s*(?:create|alter|drop|revoke|grant|comment)[^']*/gi)].map((m) => m[0])).toEqual([
      "execute format('comment on trigger contacts_retain_erasure on public.contacts is %L",
    ]);
  });

  const drifts: Array<[string, string, RegExp]> = [
    [
      "an events_insert that is not 0131's",
      "alter policy events_insert on public.events with check (org_id = (select current_org_id()) and actor_id = (select auth.uid()));",
      /0134 aborted: events_insert's check is not 0131's/,
    ],
    [
      "another trigger on contacts",
      "create trigger zz_el_extra before update on public.contacts for each row execute function public.set_updated_at();",
      /0134 aborted: the triggers on contacts are not the expected set/,
    ],
    [
      "another trigger on documents",
      "create trigger zz_el_doc_extra before update on public.documents for each row execute function public.set_updated_at();",
      /0134 aborted: the triggers on documents are not the expected set/,
    ],
    [
      "a second generated column on contacts",
      "alter table public.contacts add column zz_el_generated text generated always as (first_name) stored;",
      /0134 aborted: contacts' generated columns are not exactly display_name/,
    ],
    [
      "a SECURITY DEFINER function that writes contacts (a second door the guard would not bind)",
      "create function public.zz_el_door() returns void language sql security definer set search_path = public as $f$ update public.contacts set notes = notes where false $f$;",
      /0134 aborted: a SECURITY DEFINER function writes contacts or deletes documents \(public\.zz_el_door\)/,
    ],
    [
      "a function already holding the guard's name",
      "create function public.trg_contacts_erasure_lifecycle() returns trigger language plpgsql as $f$ begin return new; end $f$;",
      /0134 aborted: a function this file creates already exists/,
    ],
  ];
  for (const [label, drift, refusal] of drifts) {
    it(`the preflight refuses ${label}`, async () => {
      await rolledBack(async () => {
        await pg.query(REVERT_0134_SQL);
        await pg.query(drift);
        await expect(pg.query(readMigration0134())).rejects.toThrow(refusal);
      });
    });
  }

  // 0133 (origin/fix/insert-id-adoption) adds an AFTER INSERT trigger on contacts and may land before or
  // after this file: the preflight accepts exactly those two sets. CI has no 0133; the shared stack has it.
  for (const with0133 of [false, true]) {
    it(`replays over 0132 ${with0133 ? "WITH" : "WITHOUT"} 0133's contacts_id_without_history`, async () => {
      await rolledBack(async (notices) => {
        await pg.query(REVERT_0134_SQL);
        const has = (await pg.query("select 1 from pg_trigger where tgrelid = 'public.contacts'::regclass and tgname = 'contacts_id_without_history'")).rowCount === 1;
        if (with0133 && !has) {
          // a stand-in of the same name and timing — the preflight reads names
          await pg.query("create trigger contacts_id_without_history after insert on public.contacts for each row execute function public.set_updated_at()");
        }
        if (!with0133 && has) await pg.query("drop trigger contacts_id_without_history on public.contacts");
        await pg.query(readMigration0134());
        expect(notices.some((m) => m.startsWith("0134: postflight passed"))).toBe(true);
        expect(await guardExists()).toBe(true);
      });
    });
  }

  it("at the gap — 0134 rolled back inside a transaction — the consequences the audit named are real: the hot-buyer predicate matches and the phone's slot is taken", async () => {
    const c = await newContact();
    expect((await erase(admin, c)).error).toBeNull();
    const retained = (await row(c)).phone_e164 as string;
    await rolledBack(async () => {
      await pg.query(REVERT_0134_SQL);
      await asSession(agent.id);
      expect((await pg.query("update contacts set erased_at = null where id = $1", [c])).rowCount).toBe(1);
      expect((await pg.query("update contacts set is_archived = false, temperature = 'hot' where id = $1 and erased_at is null", [c])).rowCount).toBe(1);
      // the agent dashboard's hot-buyer predicate (components/features/dashboard/agent-dashboard.tsx), as the agent
      const hot = await pg.query(
        "select id from contacts where assigned_agent_id = $2 and temperature = 'hot' and contact_types @> '{buyer}' and is_archived = false and id = $1",
        [c, agent.id],
      );
      expect(hot.rowCount).toBe(1);
      await expect(
        pg.query("insert into contacts (org_id, first_name, phone_e164, created_by) values ($1, 'ZZ new owner', $2, $3)", [ORG, retained, agent.id]),
      ).rejects.toMatchObject({ code: "23505", constraint: "contacts_phone_unique" });
    });
  });

  it("no SECURITY DEFINER function writes contacts or deletes documents — the guards' trusted-path premise, held for every later migration", async () => {
    const doors = await pg.query<{ fn: string }>(
      `select ns.nspname || '.' || p.proname as fn
         from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where p.prosecdef and ns.nspname not in ('pg_catalog', 'information_schema')
          and regexp_replace(p.prosrc, '--[^\\n]*', '', 'g')
              ~* '(update\\s+(only\\s+)?(public\\.)?contacts\\y|insert\\s+into\\s+(public\\.)?contacts\\y|delete\\s+from\\s+(only\\s+)?(public\\.)?documents\\y)'
          and not exists (select 1 from pg_depend d
                           where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                             and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e')`,
    );
    expect(doors.rows).toEqual([]);
  });

  it("the rollback recipe restores 0132's behaviour: a session may clear the marker and write an erased event again", async () => {
    const c = await newContact();
    expect((await erase(admin, c)).error).toBeNull();
    await rolledBack(async () => {
      await pg.query(REVERT_0134_SQL);
      await asSession(admin.id);
      expect((await pg.query("update contacts set erased_at = null, is_archived = false where id = $1", [c])).rowCount).toBe(1);
      expect(
        (
          await pg.query(
            "insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload) values ($1, $2, 'contact', $3, 'erased', '{}')",
            [ORG, admin.id, c],
          )
        ).rowCount,
      ).toBe(1);
    });
    // …and outside it, 0134 still holds
    expect((await row(c)).erased_at).not.toBeNull();
    expect(await patch(admin.client, c, { erased_at: null })).toEqual({ ...REFUSED, message: RECORD("erased_at") });
  });

  it("the trusted paths are not bound: the service role and postgres may write the record and delete a retained document (the erasure, the purge, fixtures, maintenance)", async () => {
    const c = await newContact();
    await ownMandate(c, new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
    const doc = await kycDocument(c);
    expect((await erase(admin, c)).error).toBeNull();
    await rolledBack(async () => {
      await pg.query("set local role service_role");
      expect((await pg.query("update contacts set erased_at = null, retention_until = '2040-01-01' where id = $1", [c])).rowCount).toBe(1);
      await pg.query("update contacts set erased_at = now() where id = $1", [c]);
      expect((await pg.query("delete from documents where id = $1", [doc.id])).rowCount).toBe(1);
      await pg.query("reset role");
      expect((await pg.query("update contacts set is_archived = false where id = $1", [c])).rowCount).toBe(1);
    });
  });

  it("a misattached guard refuses to run rather than pass", async () => {
    await rolledBack(async () => {
      await pg.query(
        "create trigger zz_el_misattached before update on public.districts for each row execute function public.trg_contacts_erasure_lifecycle()",
      );
      await expect(pg.query("update districts set code = code where org_id = $1", [ORG])).rejects.toThrow(
        /trg_contacts_erasure_lifecycle runs only as a BEFORE INSERT OR UPDATE row trigger on public\.contacts/,
      );
    });
    await rolledBack(async () => {
      await pg.query(
        "create trigger zz_el_doc_misattached before update on public.districts for each row execute function public.trg_documents_kept_for_retention()",
      );
      await expect(pg.query("update districts set code = code where org_id = $1", [ORG])).rejects.toThrow(
        /trg_documents_kept_for_retention runs only as a BEFORE DELETE row trigger on public\.documents/,
      );
    });
  });

  /** The restore pack's 0134 row, exactly as scripts/backup/verify-restore.sql carries it. */
  const packRow = () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'SECURITY: an erased contact stays erased");
    const to = pack.indexOf("\n  union all\n", from);
    expect(from, "the pack carries the 0134 row").toBeGreaterThan(0);
    return `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
  };
  it("the restore pack's 0134 row passes now, and reads a disabled guard (either), 0131's policy and an unbound body", async () => {
    const now = (await pg.query<{ expected: string; actual: string }>(packRow())).rows[0]!;
    expect(now).toMatchObject({ expected: "true", actual: "true" });
    for (const drift of [
      "alter table public.contacts disable trigger contacts_retain_erasure",
      "alter table public.documents disable trigger documents_kept_for_retention",
      POLICY_0131,
      `create or replace function public.trg_contacts_erasure_lifecycle() returns trigger language plpgsql
         set search_path = public, pg_temp as $f$ begin return new; end $f$`,
      `create or replace function public.trg_documents_kept_for_retention() returns trigger language plpgsql
         set search_path = public, pg_temp as $f$ begin return old; end $f$`,
    ]) {
      await rolledBack(async () => {
        await pg.query(drift);
        const r = (await pg.query<{ expected: string; actual: string }>(packRow())).rows[0]!;
        expect(r.actual, drift).not.toBe(r.expected);
      });
    }
  });
});

describe("history is untouched", () => {
  it("the organisation's chain verifies after everything above", async () => {
    const v = await pg.query("select verify_events_chain($1) as ok", [ORG]);
    expect(v.rows[0].ok).toBe(true);
  });
});
