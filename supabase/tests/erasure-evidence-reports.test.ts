import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ANON_KEY, SUPABASE_URL, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * Erasure and the retention purge keep the contact's commission-evidence
 * reports (ERA-1, six-phase audit 2026-10-17).
 *
 * THE GAP (reproduced by this file on 99c3bad's code): `generateEvidenceReport`
 * stores its PDF as an ordinary contact document — `entity_type 'contact'`,
 * `doc_type 'evidence_report'`, path `<org>/reports/evidence-<contact>-<stamp>.pdf`
 * — and both destroyers list EVERY contact document. An erasure with no AML
 * basis removed the report's object and deleted its row; so did the purge
 * once the duty ran out. The erasure spec ("generated evidence PDFs … no — the
 * hash is the point"), the erase dialog, the contact banner and the `erased`
 * event's own `untouched: [… "evidence_reports" …]` all say a report is never
 * altered.
 *
 * THE DESIGN PINNED HERE: a report is identified by its PATH (immutable for a
 * session, 0002 protect_document_columns), never its `doc_type` (a session
 * may relabel it). Neither destroyer touches one, whatever the basis; each
 * counts what it kept (`evidence_reports_kept`); a KYC document is destroyed
 * exactly as before (the control).
 *
 * LAYERS: the report is made by the REAL `generateEvidenceReport`, the erasure
 * and the purge are the REAL server actions (only Next's request plumbing is
 * stubbed: `createClient` is the admin's aal2 session, `createAdminClient` the
 * real service client, `next-intl/server` the English catalogue). Rows and
 * objects are read back as postgres and the service role.
 *
 * A throwaway organisation, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);

const state = vi.hoisted(() => ({ queue: [] as unknown[] }));
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
  return { createAdminClient: () => h.serviceClient() };
});
// the report's words, from the English catalogue
vi.mock("next-intl/server", async () => {
  const en = (await import("@/messages/en.json")).default as Record<string, unknown>;
  return {
    getTranslations: async (ns: string) => (key: string, vars: Record<string, unknown> = {}) => {
      const text = [...ns.split("."), ...key.split(".")].reduce<unknown>(
        (node, k) => (node as Record<string, unknown> | undefined)?.[k],
        en,
      );
      if (typeof text !== "string") throw new Error(`test harness: no message ${ns}.${key}`);
      return text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
    },
  };
});

import { eraseContactPersonalData, purgeExpiredRetention } from "@/lib/actions/contact-erasure";
import { generateEvidenceReport } from "@/lib/actions/reports";
import { logEvent } from "@/lib/services/events";

let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
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

const phone = () => `+3579${randomInt(1_000_000, 9_999_999)}`;

/** A live contact with one line on its timeline (a report needs something to evidence). */
async function newContact(): Promise<string> {
  n += 1;
  const p = phone();
  const { data, error } = await svc
    .from("contacts")
    .insert({
      org_id: ORG,
      first_name: `ZZEvidence${n}`,
      last_name: RUN,
      phone_e164: p,
      phone_raw: p,
      email: `zz-evidence-${n}-${RUN}@test.local`,
      contact_types: ["buyer"],
      notes: `Private note ${n} ${RUN}`,
      kyc: { passport: { done: true } },
      assigned_agent_id: admin.id,
      created_by: admin.id,
    })
    .select("id")
    .single();
  if (error) throw new Error(`contact fixture: ${error.message}`);
  await logEvent(svc, { orgId: ORG, actorId: admin.id, entityType: "contact", entityId: data.id, eventType: "created" });
  return data.id as string;
}

/** An AML relationship: a mandate the contact owns, ending on `expiry` (a past date anchors the 5-year clock there). */
async function ownMandate(contactId: string, expiry: string) {
  n += 1;
  const { rows } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id",
    [ORG, `ZZV${RUN}${n}`.toUpperCase()],
  );
  await pg.query(
    `insert into mandates (org_id, property_id, owner_contact_id, status, type, start_date, expiry_date, renewal_reminder_days)
     values ($1, $2, $3, 'expired', 'open', $4::date - 365, $4::date, 30)`,
    [ORG, rows[0]!.id, contactId, expiry],
  );
}

/** The control: a KYC document on the contact — a real object and its row. */
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

type Report = { id: string; path: string; sha256: string };

/** The REAL report action, as the admin: its row, the path it chose, and the digest its event recorded. */
async function generateReport(contactId: string): Promise<Report> {
  const fd = new FormData();
  fd.set("contact_id", contactId);
  state.queue.push(await session(admin));
  const r = await generateEvidenceReport({ error: null, savedAt: null, documentId: null, chainOk: null, rowCount: null }, fd);
  if (r.error || !r.documentId) throw new Error(`report fixture: ${r.error}`);
  const { rows } = await pg.query<{ path: string; doc_type: string; sha256: string }>(
    `select d.storage_path as path, d.doc_type::text, e.payload->>'pdf_sha256' as sha256
       from documents d
       join events e on e.entity_id = d.entity_id and e.event_type = 'evidence_report_generated' and e.payload->>'document_id' = d.id::text
      where d.id = $1`,
    [r.documentId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.doc_type).toBe("evidence_report");
  // the path the action writes — the identity the destroyers must respect
  expect(rows[0]!.path).toMatch(new RegExp(`^${ORG}/reports/evidence-${contactId}-\\d+\\.pdf$`));
  storagePaths.push(rows[0]!.path);
  return { id: r.documentId, path: rows[0]!.path, sha256: rows[0]!.sha256 };
}

async function displayName(id: string): Promise<string> {
  return (await pg.query("select display_name from contacts where id = $1", [id])).rows[0].display_name as string;
}

async function erase(contactId: string) {
  const name = await displayName(contactId);
  state.queue.push(await session(admin));
  return eraseContactPersonalData(contactId, name);
}

async function purge(contactId: string) {
  state.queue.push(await session(admin));
  return purgeExpiredRetention(contactId);
}

const rowCount = async (id: string) =>
  (await pg.query("select count(*)::int as c from documents where id = $1", [id])).rows[0].c as number;
const objectExists = async (path: string) => (await svc.storage.from("documents").exists(path)).data === true;

/** The report is kept as evidence: its row, its object, and bytes that still hash to what its event recorded. */
async function expectReportKept(report: Report) {
  expect(await rowCount(report.id), "the report's row").toBe(1);
  expect(await objectExists(report.path), "the report's object").toBe(true);
  const { data, error } = await svc.storage.from("documents").download(report.path);
  if (error) throw new Error(`download: ${error.message}`);
  expect(createHash("sha256").update(Buffer.from(await data.arrayBuffer())).digest("hex")).toBe(report.sha256);
}

async function expectDestroyed(doc: { id: string; path: string }) {
  expect(await rowCount(doc.id), "the KYC document's row").toBe(0);
  expect(await objectExists(doc.path), "the KYC document's object").toBe(false);
}

const payloads = async (contactId: string, type: string) =>
  (
    await pg.query<{ payload: Record<string, unknown> }>(
      "select payload from events where entity_type = 'contact' and entity_id = $1 and event_type = $2 order by id",
      [contactId, type],
    )
  ).rows.map((r) => r.payload);

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Erasure evidence ${RUN}`, `erasure-evidence-${RUN}`);
  admin = await createTestUser(svc, `ee-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
}, 120_000);

afterAll(async () => {
  if (storagePaths.length) await svc.storage.from("documents").remove(storagePaths);
  await pg.query("delete from documents where org_id = $1", [ORG]);
  await pg.query("delete from mandates where org_id = $1", [ORG]);
  await pg.query("delete from properties where org_id = $1", [ORG]);
  await pg.query("delete from contacts where org_id = $1", [ORG]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  await pg.query("delete from profiles where org_id = $1", [ORG]);
  await pg.query("delete from events where org_id = $1", [ORG]);
  await pg.query("delete from events_chain_checkpoint where org_id = $1", [ORG]);
  await pg.query("delete from chain_checks where org_id = $1", [ORG]);
  await pg.query("delete from deal_stages where org_id = $1", [ORG]);
  await pg.query("delete from districts where org_id = $1", [ORG]);
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
}, 120_000);

afterEach(() => {
  expect(state.queue, "a queued client no action consumed").toEqual([]);
});

describe("the erasure keeps the commission-evidence reports (ERA-1)", () => {
  it("no AML basis: the KYC document's row and object are destroyed, the report's stay — and the record counts it kept", async () => {
    const c = await newContact();
    const kyc = await kycDocument(c);
    const report = await generateReport(c);
    expect(await erase(c)).toEqual({ error: null, erasedAt: expect.any(String) });
    await expectDestroyed(kyc);
    await expectReportKept(report);
    expect(await payloads(c, "erased")).toEqual([
      expect.objectContaining({ aml_basis: false, documents_deleted: 1, documents_retained: 0, evidence_reports_kept: 1 }),
    ]);
  }, 60_000);

  it("the report is known by its path, not its label: one a session relabelled is kept all the same", async () => {
    const c = await newContact();
    const kyc = await kycDocument(c);
    const report = await generateReport(c);
    // an admin may change a document's title and doc_type (0002), never its path
    const relabel = await admin.client.from("documents").update({ doc_type: "other", title: "Renamed" }).eq("id", report.id).select("id");
    expect(relabel.error).toBeNull();
    expect(relabel.data).toHaveLength(1);
    expect(await erase(c)).toEqual({ error: null, erasedAt: expect.any(String) });
    await expectDestroyed(kyc);
    await expectReportKept(report);
    expect(await payloads(c, "erased")).toEqual([expect.objectContaining({ documents_deleted: 1, evidence_reports_kept: 1 })]);
  }, 60_000);
});

describe("the retention purge keeps them too", () => {
  it("an expired purge destroys the KYC document kept under the duty and keeps the report — row and object", async () => {
    const c = await newContact();
    await ownMandate(c, "2015-06-01"); // anchor 2015 → retention 2020: already lapsed
    const kyc = await kycDocument(c);
    const report = await generateReport(c);
    expect(await erase(c)).toEqual({ error: null, erasedAt: expect.any(String) });
    // the duty keeps both through the erasure
    expect(await rowCount(kyc.id)).toBe(1);
    expect(await objectExists(kyc.path)).toBe(true);
    await expectReportKept(report);
    expect((await pg.query("select retention_until::text as r from contacts where id = $1", [c])).rows[0].r).toBe("2020-06-01");

    expect(await purge(c)).toEqual({ error: null, purgedAt: expect.any(String) });
    await expectDestroyed(kyc);
    await expectReportKept(report);
    expect(await payloads(c, "erased")).toEqual([
      expect.objectContaining({ aml_basis: true, documents_deleted: 0, documents_retained: 1, evidence_reports_kept: 1 }),
    ]);
    expect(await payloads(c, "retention_purged")).toEqual([
      { documents_destroyed: 1, evidence_reports_kept: 1, retention_until: "2020-06-01" },
    ]);
  }, 60_000);
});

describe("history is untouched", () => {
  it("the organisation's chain verifies after everything above", async () => {
    const v = await pg.query("select verify_events_chain($1) as ok", [ORG]);
    expect(v.rows[0].ok).toBe(true);
  });
});
