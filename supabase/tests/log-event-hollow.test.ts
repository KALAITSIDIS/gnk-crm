import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import {
  ANON_KEY,
  SERVICE_ROLE_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * An event write is believed only when PostgREST confirms it — through the
 * REAL `logEvent` / `logEvents`, a real aal2 session, the real service role,
 * a REAL PostgREST behind the local Kong, and the real contacts export route
 * (T-log-event-hollow).
 *
 * At b55b095 logEvent threw on a truthy `error` only. postgrest-js reports an
 * OK answer with an empty body, a 404 with an empty body (as 204) and a `null`
 * body even under a 500 as `error: null`, and a 500 whose body is `0` as a
 * FALSY error (measured, 2.110.2), so each was taken for a written event:
 * measured with this harness, the contacts export handed over its CSV of
 * personal data with NO audit line behind it.
 *
 * WHAT IT PINS (each scenario prints one `[evidence]` line):
 *   1. the guard does not misfire: PostgREST answers logEvent's and
 *      logEvents' requests 201 Created on the session client and on the
 *      service role, the rows are there and the chain verifies — a success
 *      the guard refused would fail every mutation in the app;
 *   2. a hollow answer is refused whether or not the write landed: the
 *      request that never arrived wrote nothing, the one whose answer was
 *      lost on the way back DID write its row — "not confirmed" is not
 *      "not written", which is why every refusal says the former;
 *   3. the contacts export, its audit line answered hollow, releases no CSV:
 *      fail closed, as for any other failed audit write;
 *   4. the viewing confirmation and 5. the evidence report — the two actions
 *      that undo their own document when its event fails — undo it only on
 *      the DATABASE's refusal. Any other failure may have written the line,
 *      which names the document by id and digest: the action reads it back as
 *      the system and keeps the document, succeeding when the line is there
 *      and saying it could not be confirmed when it is not (or the read-back
 *      fails). At b55b095 a code-less failure whose line had landed — a
 *      gateway's 502, say — destroyed the document the line names.
 *
 * A fault is the only way such an answer arrives, so the test injects it at
 * the client's transport: ONE POST to /rest/v1/events, either forwarded to the
 * stack with its answer replaced (the write LANDS) or never sent; for the
 * read-back, ONE service-role GET of the line answered 500.
 *
 * THROWAWAY ORGANISATION, deleted at the end as postgres, events and storage
 * included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

/** The ONE events insert to fault, the ONE read-back to fail, and what the transport saw. */
const steer = vi.hoisted(() => ({
  fault: null as null | { answer: () => Response; forward: boolean },
  readFault: null as null | (() => Response),
  /** `status` of every events insert PostgREST really answered */
  answered: [] as number[],
  faulted: 0,
  readFaulted: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this request");
    return c;
  },
}));
// the real service-role client; the read-back of a document's line can be failed once
vi.mock("@/lib/supabase/admin", async () => {
  const { createClient: make } = await import("@supabase/supabase-js");
  const h = await import("./helpers");
  return {
    createAdminClient: () =>
      make(h.SUPABASE_URL, h.SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = decodeURIComponent(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
            const method = (init?.method ?? "GET").toUpperCase();
            const f = steer.readFault;
            if (f && method === "GET" && url.includes("/rest/v1/events?") && url.includes("payload->>document_id=eq.")) {
              steer.readFault = null;
              steer.readFaulted++;
              return f();
            }
            return fetch(input, init);
          },
        },
      }),
  };
});
// the evidence report's words, from the English catalogue
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

import { logEvent, logEvents, type LogEventParams } from "@/lib/services/events";
import { GET as contactsExport } from "@/app/(app)/contacts/export/route";
import { generateViewingConfirmation } from "@/lib/actions/viewing-documents";
import { generateEvidenceReport } from "@/lib/actions/reports";

const JSONH = { "content-type": "application/json; charset=utf-8" };
/** [shape, the answer, the status the refusal names] */
const HOLLOW: [string, () => Response, string][] = [
  ["200 empty", () => new Response("", { status: 200, headers: JSONH }), "HTTP 200"],
  ["404 empty", () => new Response("", { status: 404, headers: JSONH }), "HTTP 204"],
  ["200 null", () => new Response("null", { status: 200, headers: JSONH }), "HTTP 200"],
  ["500 null", () => new Response("null", { status: 500, headers: JSONH }), "HTTP 500"],
  ["500 0", () => new Response("0", { status: 500, headers: JSONH }), "HTTP 500"],
];

/** A client on `key` (and, for a user, their aal2 session) whose events inserts are recorded and can be faulted. */
async function clientFor(user: TestUser | null): Promise<SupabaseClient> {
  const c = createClient(SUPABASE_URL, user ? ANON_KEY : SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (method !== "POST" || new URL(url).pathname !== "/rest/v1/events") return fetch(input, init);
        const f = steer.fault;
        if (f) {
          steer.fault = null; // one request only
          steer.faulted++;
          if (f.forward) await (await fetch(input, init)).arrayBuffer();
          return f.answer();
        }
        const res = await fetch(input, init);
        steer.answered.push(res.status);
        return res;
      },
    },
  });
  if (user) {
    const s = (await user.client.auth.getSession()).data.session;
    if (!s) throw new Error(`no session for ${user.email}`);
    const { error } = await c.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
    if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  }
  return c;
}

let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let contactId = "";
let viewingId = "";
let n = 0;

/** An event naming this run's `mark`, so its rows can be counted. */
const event = (mark: string): LogEventParams => ({
  orgId: ORG,
  actorId: admin.id,
  entityType: "config",
  eventType: "updated",
  payload: { probe: mark },
});
const nextMark = () => `${RUN}-${++n}`;
const rowsMarked = async (mark: string) =>
  (await pg.query("select count(*)::int as c from events where org_id = $1 and payload->>'probe' = $2", [ORG, mark])).rows[0]
    .c as number;
const exported = async () =>
  (await pg.query("select count(*)::int as c from events where org_id = $1 and entity_type = 'export' and event_type = 'exported'", [ORG]))
    .rows[0].c as number;

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `logEvent hollow ${RUN}`, `log-event-hollow-${RUN}`);
  admin = await createTestUser(svc, `leh-admin-${RUN}@test.local`, "admin", ORG);
  contactId = (
    await pg.query<{ id: string }>(
      "insert into contacts (org_id, first_name, last_name, created_by) values ($1, 'Hollow', $2, $3) returning id",
      [ORG, RUN, admin.id],
    )
  ).rows[0]!.id;
  const propertyId = (
    await pg.query<{ id: string }>(
      "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id",
      [ORG, `LEH${RUN}`.toUpperCase()],
    )
  ).rows[0]!.id;
  viewingId = (
    await pg.query<{ id: string }>(
      "insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at) values ($1, $2, $3, $4, now() + interval '7 days') returning id",
      [ORG, propertyId, contactId, admin.id],
    )
  ).rows[0]!.id;
}, 180_000);

afterEach(() => {
  steer.fault = null;
  steer.readFault = null;
  steer.answered = [];
  steer.faulted = 0;
  steer.readFaulted = 0;
});

afterAll(async () => {
  for (const prefix of [`${ORG}/viewings`, `${ORG}/reports`]) {
    const { data } = await svc.storage.from("documents").list(prefix, { limit: 1000 });
    const paths = (data ?? []).map((o) => `${prefix}/${o.name}`);
    if (paths.length) await svc.storage.from("documents").remove(paths);
  }
  for (const t of ["documents", "viewings", "properties", "contacts"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  if (admin) await svc.auth.admin.deleteUser(admin.id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
}, 180_000);

describe("1. a confirmed write is a 201, and the guard lets it through", () => {
  it.each([
    ["the session (aal2 admin)", "session"],
    ["the service role", "service"],
  ] as const)("%s: one row and three, each answered 201 and there", async (_, who) => {
    const client = await clientFor(who === "session" ? admin : null);
    const one = nextMark();
    const many = nextMark();
    await logEvent(client, event(one));
    await logEvents(client, [event(many), event(many), event(many)]);
    console.log(`[evidence] ${who}: events inserts answered ${steer.answered.join(", ")}`);
    expect(steer.answered).toEqual([201, 201]);
    expect(await rowsMarked(one)).toBe(1);
    expect(await rowsMarked(many)).toBe(3);
  });
});

describe("2. an answer that does not confirm the write is refused, landed or not", () => {
  it.each(HOLLOW)("%s, the request never arrived: refused, nothing written", async (shape, answer, status) => {
    const client = await clientFor(admin);
    const mark = nextMark();
    steer.fault = { answer, forward: false };
    const outcome = await logEvent(client, event(mark)).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    console.log(`[evidence] ${shape}, not sent: ${outcome}; rows ${await rowsMarked(mark)}`);
    expect(steer.faulted).toBe(1);
    expect(outcome).toBe(`logEvent failed (config.updated): the write was not confirmed (${status})`);
    expect(await rowsMarked(mark)).toBe(0);
  });

  it.each(HOLLOW)("%s, the answer was lost on the way back: refused, though the row landed", async (shape, answer, status) => {
    const client = await clientFor(admin);
    const mark = nextMark();
    steer.fault = { answer, forward: true };
    const outcome = await logEvents(client, [event(mark), event(mark)]).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    console.log(`[evidence] ${shape}, sent: ${outcome}; rows ${await rowsMarked(mark)}`);
    expect(steer.faulted).toBe(1);
    expect(outcome).toBe(`logEvents failed (2 rows): the write was not confirmed (${status})`);
    expect(await rowsMarked(mark), "the write landed — not confirmed is not not-written").toBe(2);
  });
});

describe("3. the contacts export releases no CSV behind an unconfirmed audit line", () => {
  async function exportContacts() {
    const client = await clientFor(admin);
    try {
      const res = await ctx.als.run(client, () => contactsExport(new NextRequest("http://localhost/contacts/export")));
      return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
    } catch (e) {
      return { status: 500, type: "thrown", body: (e as Error).message }; // a route's throw is Next's 500
    }
  }

  it("control: no fault — a CSV holding the contact, and one audit line", async () => {
    const before = await exported();
    const a = await exportContacts();
    console.log(`[evidence] export, no fault: ${a.status} ${a.type}`);
    expect(a.status).toBe(200);
    expect(a.type).toContain("text/csv");
    expect(a.body).toContain(RUN);
    expect(await exported()).toBe(before + 1);
  });

  it.each(HOLLOW)("%s on the audit line: no CSV", async (shape, answer, status) => {
    steer.fault = { answer, forward: false };
    const before = await exported();
    const a = await exportContacts();
    console.log(`[evidence] export, audit ${shape}: ${a.status} ${a.type} ${a.type === "thrown" ? a.body : ""}`);
    expect(steer.faulted).toBe(1);
    expect(a.type, "a CSV of personal data left without its audit line").not.toContain("text/csv");
    expect(a.body).not.toContain(RUN);
    expect(a.body).toBe(`logEvent failed (export.exported): the write was not confirmed (${status})`);
    expect(await exported()).toBe(before);
  });
});

/** A document an action filed, and whether its file and its line are there. */
type Filed = { id: string; storage_path: string };
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: JSONH });

type Outcome = "kept" | "rolled back" | "unconfirmed";
type Case = {
  name: string;
  fault: { answer: () => Response; forward: boolean } | null;
  readFault?: () => Response;
  outcome: Outcome;
  /** whether the document's line is on the chain afterwards */
  line: boolean;
};
const CASES: Case[] = [
  { name: "no fault", fault: null, outcome: "kept", line: true },
  {
    name: "the database refused the line (500, XX000)",
    fault: { answer: json(500, { code: "XX000", message: "injected refusal" }), forward: false },
    outcome: "rolled back",
    line: false,
  },
  {
    name: "200 empty, the line landed",
    fault: { answer: () => new Response("", { status: 200, headers: JSONH }), forward: true },
    outcome: "kept",
    line: true,
  },
  {
    name: "a gateway's 502 with no code, the line landed",
    fault: { answer: json(502, { message: "An invalid response was received from the upstream server" }), forward: true },
    outcome: "kept",
    line: true,
  },
  {
    name: "404 empty, the request never arrived",
    fault: { answer: () => new Response("", { status: 404, headers: JSONH }), forward: false },
    outcome: "unconfirmed",
    line: false,
  },
  {
    name: "200 empty, the line landed, but reading it back failed",
    fault: { answer: () => new Response("", { status: 200, headers: JSONH }), forward: true },
    readFault: json(500, { code: "XX000", message: "read-back refused" }),
    outcome: "unconfirmed",
    line: true,
  },
];

const objectExists = async (path: string) => (await svc.storage.from("documents").exists(path)).data === true;
const objectCount = async (prefix: string, search: string) =>
  ((await svc.storage.from("documents").list(prefix, { search, limit: 1000 })).data ?? []).length;
const linesNaming = async (eventType: string, entityId: string, documentId: string) =>
  (
    await pg.query(
      "select count(*)::int as c from events where org_id = $1 and entity_id = $2 and event_type = $3 and payload->>'document_id' = $4",
      [ORG, entityId, eventType, documentId],
    )
  ).rows[0].c as number;
/** Every line of that type on the entity, whatever document it names. */
const linesOn = async (eventType: string, entityId: string) =>
  (
    await pg.query("select count(*)::int as c from events where org_id = $1 and entity_id = $2 and event_type = $3", [
      ORG,
      entityId,
      eventType,
    ])
  ).rows[0].c as number;

/**
 * Run one action under one case and check what it left: the document (kept,
 * or gone with its file), its line, and what the user was told.
 */
async function expectCase(
  c: Case,
  a: {
    label: string;
    run: () => Promise<{ error: string | null; documentId: string | null }>;
    filed: () => Promise<Filed[]>;
    prefix: string;
    search: string;
    eventType: string;
    entityId: string;
    rolledBack: string;
    unconfirmed: string;
  },
) {
  steer.fault = c.fault;
  steer.readFault = c.readFault ?? null;
  const before = await a.filed();
  const objectsBefore = await objectCount(a.prefix, a.search);
  const linesBefore = await linesOn(a.eventType, a.entityId);
  const result = await a.run();
  const newLines = (await linesOn(a.eventType, a.entityId)) - linesBefore;
  const filed = (await a.filed()).filter((d) => !before.some((b) => b.id === d.id));
  const doc = filed[0];
  const lines = doc ? await linesNaming(a.eventType, a.entityId, doc.id) : 0;
  const file = doc ? await objectExists(doc.storage_path) : false;
  console.log(
    `[evidence] ${a.label}, ${c.name}: ${result.error ?? "ok"} | documents +${filed.length}, file ${file ? "kept" : "none"}, lines naming it ${lines}, new lines ${newLines}`,
  );
  expect(steer.faulted, "the fault reached the event write").toBe(c.fault ? 1 : 0);
  expect(steer.readFaulted, "the read-back fault reached the read-back").toBe(c.readFault ? 1 : 0);
  expect(newLines, "lines written, naming this document or one destroyed").toBe(c.line ? 1 : 0);
  if (c.outcome === "rolled back") {
    expect(result.error).toBe(a.rolledBack);
    expect(filed, "the refused document's row is gone").toEqual([]);
    expect(await objectCount(a.prefix, a.search), "its file is gone").toBe(objectsBefore);
    return;
  }
  expect(filed, "one document filed and kept").toHaveLength(1);
  expect(file, "its file is kept").toBe(true);
  expect(lines, "its line on the chain").toBe(c.line ? 1 : 0);
  if (c.outcome === "kept") {
    expect(result.error).toBeNull();
    expect(result.documentId).toBe(doc!.id);
  } else {
    expect(result.error).toBe(a.unconfirmed);
  }
}

/** What logEvent says for the two hollow answers the unconfirmed cases use. */
const NOT_CONFIRMED = (type: string, c: Case) =>
  `logEvent failed (${type}): the write was not confirmed (${c.fault?.forward === false ? "HTTP 204" : "HTTP 200"})`;

describe("4. the viewing confirmation is undone only on the database's refusal", () => {
  const TYPE = "viewing.viewing_confirmation_generated";
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_, c) => {
    await expectCase(c, {
      label: "confirmation",
      run: async () => {
        const fd = new FormData();
        fd.set("viewing_id", viewingId);
        const session = await clientFor(admin);
        return ctx.als.run(session, () => generateViewingConfirmation({ error: null, savedAt: null, documentId: null }, fd));
      },
      filed: async () =>
        (
          await pg.query<Filed>(
            "select id::text, storage_path from documents where org_id = $1 and entity_id = $2 and doc_type = 'viewing_confirmation'",
            [ORG, viewingId],
          )
        ).rows,
      prefix: `${ORG}/viewings`,
      search: `confirmation-${viewingId}`,
      eventType: "viewing_confirmation_generated",
      entityId: viewingId,
      rolledBack: `Rolled back: logEvent failed (${TYPE}): injected refusal`,
      unconfirmed: `The confirmation is saved, but its line on the viewing's timeline could not be confirmed: ${NOT_CONFIRMED(TYPE, c)}. Reload the viewing before generating another.`,
    });
  });
});

describe("5. the evidence report is undone only on the database's refusal", () => {
  const TYPE = "contact.evidence_report_generated";
  beforeAll(async () => {
    // the report needs something to evidence: one line on the contact
    await logEvent(svc, { orgId: ORG, actorId: admin.id, entityType: "contact", entityId: contactId, eventType: "created" });
  });

  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s",
    async (_, c) => {
      await expectCase(c, {
        label: "report",
        run: async () => {
          const fd = new FormData();
          fd.set("contact_id", contactId);
          const session = await clientFor(admin);
          return ctx.als.run(session, () =>
            generateEvidenceReport({ error: null, savedAt: null, documentId: null, chainOk: null, rowCount: null }, fd),
          );
        },
        filed: async () =>
          (
            await pg.query<Filed>(
              "select id::text, storage_path from documents where org_id = $1 and entity_id = $2 and storage_path like $3",
              [ORG, contactId, `${ORG}/reports/evidence-${contactId}-%`],
            )
          ).rows,
        prefix: `${ORG}/reports`,
        search: `evidence-${contactId}`,
        eventType: "evidence_report_generated",
        entityId: contactId,
        rolledBack: `Report rolled back — its event could not be written: logEvent failed (${TYPE}): injected refusal`,
        unconfirmed: `The report is saved, but its line on the timeline could not be confirmed: ${NOT_CONFIRMED(TYPE, c)}. Reload the page before generating it again.`,
      });
    },
    60_000,
  );
});

describe("the chain", () => {
  it("verifies for the throwaway organisation after every scenario above", async () => {
    const { rows } = await pg.query<{ ok: boolean; reason: string | null }>(
      "select ok, reason from verify_events_chain($1::uuid, null::bigint)",
      [ORG],
    );
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
