import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  ANON_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * A signed viewing slip's signature PNG and PDF are never destroyed — through
 * the REAL `signViewingSlip`, real PDF rendering, a real aal2 admin session, the
 * real service role, REAL Storage and PostgREST behind the local Kong
 * (T-signed-slip-kept).
 *
 * At 86f3d22 the action asked "already signed?" with a `maybeSingle` whose
 * error it never read, then REMOVED whatever sat at the slip's two fixed paths
 * before uploading (INT-08's pre-clean), then on the unique key's 23505 took
 * its own uploads back — from those same paths. Measured with this harness:
 *   - every hollow answer to that read (empty 200, empty 404, `null` under a
 *     200 or a 500, a falsy `0`) AND a plain statement timeout left the signed
 *     slip's row and its event pointing at an EMPTY bucket — while the user was
 *     told "This viewing already has a signed slip." (the message alone cannot
 *     go red: storage writes and bytes are asserted);
 *   - two concurrent signings, forced at either window, did the same to the
 *     winner's files;
 *   - an insert that never arrived (500 `null`) was reported as SUCCESS, with
 *     an event for a slip that does not exist;
 *   - a hollow organisation read signed a PDF saying "Agency".
 *
 * A fault is the only way such an answer arrives, so the test injects it: both
 * clients' `fetch` answer ONE request (matched by method and URL — on either
 * client, since the fix moves the check to the service role) hollow,
 * forwarded by default. A one-shot gate holds one attempt at one request so a
 * race is forced, never left to timing.
 *
 * THROWAWAY ORGANISATION, deleted at the end as postgres, storage included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);

/**
 * One faulty request: answered at once with `answer()`. `forward` (default)
 * sends it first — it lands, its answer is lost; `forward: false` never sends
 * it; `later` keeps it to send when the test says — it lands AFTER its error.
 */
type Fault = {
  match: (method: string, url: string) => boolean;
  answer: () => Response;
  forward?: boolean;
  later?: boolean;
  times?: number;
};
type Gate = { match: (method: string, url: string) => boolean; reached: () => void; release: Promise<void> };

const state = vi.hoisted(() => ({
  queue: [] as unknown[],
  fault: null as Fault | null,
  gate: null as Gate | null,
  hits: [] as string[],
  adminWrites: [] as string[],
  sessionWrites: [] as string[],
  /** requests a `later` fault kept, to be sent when the test says */
  kept: [] as Array<() => Promise<number>>,
}));

/** One shim for both clients: the gate, then the fault, else the real request. */
async function shimmed(where: "session" | "admin", input: RequestInfo | URL, init?: RequestInit) {
  const method = (init?.method ?? "GET").toUpperCase();
  const url = decodeURIComponent(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (method !== "GET" && method !== "HEAD") (where === "admin" ? state.adminWrites : state.sessionWrites).push(`${method} ${new URL(url).pathname}`);
  const g = state.gate;
  if (g?.match(method, url)) {
    state.gate = null;
    g.reached();
    await g.release;
  }
  const f = state.fault;
  if (f?.match(method, url) && (f.times ?? 1) > 0) {
    f.times = (f.times ?? 1) - 1;
    state.hits.push(`${where} ${method} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
    if (f.later) {
      state.kept.push(async () => {
        const res = await fetch(input, init);
        await res.arrayBuffer();
        return res.status;
      });
    } else if (f.forward ?? true) await (await fetch(input, init)).arrayBuffer();
    return f.answer();
  }
  return fetch(input, init);
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
    if (!c) throw new Error("test harness: no client queued");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const { createClient: make } = await import("@supabase/supabase-js");
  const h = await import("./helpers");
  return {
    createAdminClient: () =>
      make(h.SUPABASE_URL, h.SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => shimmed("admin", input, init) },
      }),
  };
});

import { signViewingSlip } from "@/lib/actions/viewing-slips";
import SignSlipPage from "@/app/(app)/viewings/[id]/sign/page";
import ViewingDetailPage from "@/app/(app)/viewings/[id]/page";
import { SignSlip } from "@/components/features/viewings/sign-slip";
import { SlipDownloadButton } from "@/components/features/viewings/slip-download";
import { extractPdfText } from "@/lib/testing/pdf-text";

// ---------------------------------------------------------------- PNGs
function crc32(buf: Buffer) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A real 4×4 PNG of one colour — the renderer embeds it. */
function png(r: number, g: number, b: number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.from([0, r, g, b, r, g, b, r, g, b, r, g, b]);
  const raw = Buffer.concat([row, row, row, row]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const ORIGINAL = png(20, 20, 160);
const SECOND = png(160, 20, 20);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- harness
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let n = 0;

async function session() {
  const s = (await admin.client.auth.getSession()).data.session!;
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => shimmed("session", input, init) },
  });
  const { error } = await c.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession: ${error.message}`);
  return c;
}

async function newViewing(): Promise<string> {
  n += 1;
  const prop = (await pg.query<{ id: string }>("insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id", [ORG, `SLP${RUN}${n}`.toUpperCase()])).rows[0]!.id;
  const contact = (await pg.query<{ id: string }>("insert into contacts (org_id, first_name, last_name) values ($1, $2, $3) returning id", [ORG, `Slip${n}`, RUN])).rows[0]!.id;
  return (
    await pg.query<{ id: string }>(
      "insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at) values ($1, $2, $3, $4, now() - interval '1 hour') returning id",
      [ORG, prop, contact, admin.id],
    )
  ).rows[0]!.id;
}
const paths = (v: string) => ({ png: `${ORG}/${v}.png`, pdf: `${ORG}/${v}.pdf` });

function form(v: string, img: Buffer, signer = "Fixture Buyer") {
  const fd = new FormData();
  fd.set("viewing_id", v);
  fd.set("signer_name", signer);
  fd.set("signature_data", `data:image/png;base64,${img.toString("base64")}`);
  return fd;
}

/** Sign once, with at most one faulty request. */
async function sign(v: string, img: Buffer, fault: Fault | null = null) {
  state.hits = [];
  state.adminWrites = [];
  state.sessionWrites = [];
  state.fault = fault;
  state.queue.push(await session());
  try {
    const r = await signViewingSlip({ error: null, savedAt: null }, form(v, img));
    return { error: r.error, ok: r.savedAt !== null, hits: [...state.hits], adminWrites: [...state.adminWrites], sessionWrites: [...state.sessionWrites] };
  } finally {
    state.fault = null;
  }
}

async function objSha(p: string) {
  const { data, error } = await svc.storage.from("signatures").download(p);
  return error || !data ? null : sha(Buffer.from(await data.arrayBuffer()));
}
/** The row, the objects (by id and by bytes) and the events. */
async function observe(v: string) {
  const p = paths(v);
  const rows = (await pg.query("select id, signature_sha256, pdf_sha256 from viewing_slips where viewing_id = $1", [v])).rows;
  const objects = (await pg.query("select id, name from storage.objects where bucket_id = 'signatures' and name = any($1) order by name", [[p.pdf, p.png]])).rows;
  const events = (await pg.query("select payload from events where entity_type = 'viewing' and entity_id = $1 and event_type = 'viewing_slip_signed' order by id", [v])).rows.map(
    (r) => r.payload as { sha256: string; pdf_sha256: string },
  );
  return {
    rows: rows.length,
    rowPng: (rows[0]?.signature_sha256 as string | undefined) ?? null,
    rowPdf: (rows[0]?.pdf_sha256 as string | undefined) ?? null,
    objectIds: objects.map((o) => o.id as string),
    pngSha: await objSha(p.png),
    pdfSha: await objSha(p.pdf),
    events,
  };
}
/** What the row and its event claim is what Storage holds. */
function expectIntact(o: Awaited<ReturnType<typeof observe>>) {
  expect(o.rows, "one row").toBe(1);
  expect(o.pngSha, "the signature PNG is there, byte for byte").toBe(o.rowPng);
  expect(o.pdfSha, "the signed PDF is there, byte for byte").toBe(o.rowPdf);
  expect(o.events, "one event, naming the same bytes").toEqual([expect.objectContaining({ sha256: o.rowPng, pdf_sha256: o.rowPdf })]);
}

const JSONH = { "content-type": "application/json; charset=utf-8" };
const ANSWERS = {
  "200 empty": { answer: () => new Response("", { status: 200, headers: JSONH }), forward: true, why: "the signed slip: the answer held no rows (HTTP 200)" },
  "404 empty": { answer: () => new Response("", { status: 404, headers: JSONH }), forward: true, why: "the signed slip: the answer held no rows (HTTP 204)" },
  "200 null": { answer: () => new Response("null", { status: 200, headers: JSONH }), forward: true, why: "the signed slip: the answer held no rows (HTTP 200)" },
  "500 null": { answer: () => new Response("null", { status: 500, headers: JSONH }), forward: true, why: "the signed slip: the answer held no rows (HTTP 500)" },
  "500 0": { answer: () => new Response("0", { status: 500, headers: JSONH }), forward: true, why: "the signed slip: the answer held no rows (HTTP 500)" },
  "a statement timeout": {
    answer: () =>
      new Response(JSON.stringify({ code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" }), { status: 500, headers: JSONH }),
    forward: false,
    why: "the signed slip: canceling statement due to statement timeout",
  },
} as const;
type Shape = keyof typeof ANSWERS;
/** The "already signed?" read — on whichever client sends it. */
const slipCheck = (v: string) => (m: string, u: string) => m === "GET" && u.includes("/rest/v1/viewing_slips?") && u.includes(`viewing_id=eq.${v}`);

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Slip null answers ${RUN}`, `slip-null-answers-${RUN}`);
  admin = await createTestUser(svc, `slip-admin-${RUN}@test.local`, "admin", ORG);
}, 180_000);

afterAll(async () => {
  const objs = (await pg.query("select name from storage.objects where bucket_id = 'signatures' and name like $1", [`${ORG}/%`])).rows.map((r) => r.name as string);
  if (objs.length) await svc.storage.from("signatures").remove(objs);
  for (const t of ["viewing_slips", "viewings", "contacts", "properties"]) await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  if (admin) await svc.auth.admin.deleteUser(admin.id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
}, 180_000);

afterEach(() => {
  expect(state.queue, "a queued client nothing consumed").toEqual([]);
  expect(state.kept, "a kept request nothing sent").toEqual([]);
  state.gate = null;
});

// ---------------------------------------------------------------- the check
describe("a signed slip is never destroyed by an unclear 'already signed?' answer", () => {
  it("the control: a first signing is intact; a second is refused with nothing written", async () => {
    const v = await newViewing();
    const first = await sign(v, ORIGINAL);
    expect(first.error).toBeNull();
    const o1 = await observe(v);
    expectIntact(o1);
    expect(o1.pngSha).toBe(sha(ORIGINAL));
    const again = await sign(v, SECOND);
    expect(again).toMatchObject({ error: "This viewing already has a signed slip.", ok: false, adminWrites: [], sessionWrites: [] });
    expect(await observe(v)).toEqual(o1);
  });

  it.each(Object.keys(ANSWERS) as Shape[])("a signed viewing, the check answered %s: refused — the files untouched, byte for byte", async (shape) => {
    const v = await newViewing();
    expect((await sign(v, ORIGINAL)).ok).toBe(true);
    const before = await observe(v);
    const a = ANSWERS[shape];
    const r = await sign(v, SECOND, { match: slipCheck(v), answer: a.answer, forward: a.forward });
    console.log(`[evidence] check ${shape}: ${JSON.stringify({ error: r.error, adminWrites: r.adminWrites.length, sessionWrites: r.sessionWrites.length })}`);
    expect(r.hits, "the fault reached the check").toHaveLength(1);
    expect(r.error).toBe(`Could not check whether this viewing is already signed — nothing was changed: ${a.why}`);
    expect(r.adminWrites, "no storage write, no removal").toEqual([]);
    expect(r.sessionWrites, "no second row, no event").toEqual([]);
    expect(await observe(v), "the same row, the same objects, the same bytes").toEqual(before);
    expectIntact(before);
  });
});

// ---------------------------------------------------------------- races
describe("two signings at once leave exactly one slip, intact", () => {
  /** B is held at `gateAt` while A signs in full; then B goes on. */
  async function race(gateAt: (v: string) => Gate["match"]) {
    const v = await newViewing();
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((res) => (reached = res));
    state.gate = { match: gateAt(v), reached, release: new Promise<void>((res) => (release = res)) };
    state.queue.push(await session());
    const bP = signViewingSlip({ error: null, savedAt: null }, form(v, SECOND, "B Signer"));
    const first = await Promise.race([reachedP.then(() => "gate"), bP.then(() => "b finished")]);
    expect(first, "the race was exercised: B reached the gate").toBe("gate");
    const a = await sign(v, ORIGINAL);
    release();
    const b = await bP;
    const o = await observe(v);
    console.log(`[evidence] race: A ${JSON.stringify(a.error)}, B ${JSON.stringify(b.error)}, png ${o.pngSha === sha(ORIGINAL) ? "A's" : o.pngSha === sha(SECOND) ? "B's" : "GONE"}`);
    expect([a.ok, b.savedAt !== null].filter(Boolean), "exactly one signing succeeded").toHaveLength(1);
    expectIntact(o);
    expect(o.pngSha, "the winner's signature").toBe(a.ok ? sha(ORIGINAL) : sha(SECOND));
    return { a, b };
  }

  it("B held at its first storage write while A signs: one slip, its files intact", async () => {
    await race(() => (m, u) => m !== "GET" && m !== "HEAD" && u.includes("/storage/v1/object/signatures"));
  });

  it("B held at its row insert (its files up) while A signs: one slip, its files intact", async () => {
    await race(() => (m, u) => m === "POST" && u.includes("/rest/v1/viewing_slips"));
  });
});

// ---------------------------------------------------------------- the insert
describe("the slip's insert is never read as done — or undone — on an unclear answer", () => {
  const insertPost = (m: string, u: string) => m === "POST" && u.includes("/rest/v1/viewing_slips");
  /** Age every slip file of the viewing past the 5-minute lease. */
  const age = (v: string) =>
    pg.query("update storage.objects set created_at = now() - interval '30 minutes' where bucket_id = 'signatures' and name = any($1)", [[paths(v).png, paths(v).pdf]]);

  it("the insert never arrived (500 null, no code): NOT a success, nothing removed — the files cleared later, then a clean signing", async () => {
    const v = await newViewing();
    const r = await sign(v, ORIGINAL, { match: insertPost, answer: ANSWERS["500 null"].answer, forward: false });
    expect(r.hits).toHaveLength(1);
    expect(r).toMatchObject({ error: "The slip may not have been saved (HTTP 500) — reload the viewing in a few minutes before signing again.", ok: false });
    const o = await observe(v);
    expect(o.rows).toBe(0);
    expect(o.events, "no event for a slip that does not exist").toEqual([]);
    expect(o.objectIds, "a code-less failure may still land: its files are kept").toHaveLength(2);
    // within the lease: in progress; after it, with still no row: cleared — then a clean signing
    expect((await sign(v, ORIGINAL)).error).toBe(
      "Another signing of this viewing is in progress, or one that did not finish left its files — try again in 5 minutes.",
    );
    await age(v);
    expect((await sign(v, ORIGINAL)).error).toBe("An earlier signing that did not finish had left files behind; they have been cleared. Please sign again.");
    expect((await sign(v, ORIGINAL)).ok).toBe(true);
    expectIntact(await observe(v));
  });

  it("a refusal the database gave (a SQLSTATE): the uploads are taken back — a re-sign succeeds at once", async () => {
    const v = await newViewing();
    const refusal = () =>
      new Response(JSON.stringify({ code: "42501", details: null, hint: null, message: "new row violates row-level security policy" }), { status: 403, headers: JSONH });
    const r = await sign(v, ORIGINAL, { match: insertPost, answer: refusal, forward: false });
    expect(r).toMatchObject({ error: "new row violates row-level security policy", ok: false });
    expect((await observe(v)).objectIds, "taken back").toEqual([]);
    expect((await sign(v, ORIGINAL)).ok).toBe(true);
    expectIntact(await observe(v));
  });

  it("the insert answered 502 and landed after its error: the files were kept — the row points at its own bytes", async () => {
    const v = await newViewing();
    const r = await sign(v, ORIGINAL, { match: insertPost, answer: () => new Response("", { status: 502 }), later: true });
    expect(r).toMatchObject({ error: "The slip may not have been saved (HTTP 502) — reload the viewing in a few minutes before signing again.", ok: false });
    expect(await state.kept.shift()!(), "the late insert committed").toBe(201);
    const o = await observe(v);
    expect(o.rows).toBe(1);
    expect(o.pngSha, "its signature is there").toBe(o.rowPng);
    expect(o.pdfSha, "its PDF is there").toBe(o.rowPdf);
    // the event of a slip whose insert landed after its answer is missing (BACKLOG); the slip is not lost
    expect((await sign(v, SECOND)).error).toBe("This viewing already has a signed slip.");
  });

  it("the insert landed, its answer a 504: re-read as this attempt's own row — recorded, its files kept", async () => {
    const v = await newViewing();
    const r = await sign(v, ORIGINAL, { match: insertPost, answer: () => new Response("", { status: 504 }) });
    expect(r.hits).toHaveLength(1);
    expect(r.error).toBeNull();
    expectIntact(await observe(v));
  });

  it("an attempt's PDF upload answered an error and LANDED after a later attempt signed: refused by Storage — the later slip intact", async () => {
    const v = await newViewing();
    const pdfPost = (m: string, u: string) => m === "POST" && u.includes(`/storage/v1/object/signatures/${paths(v).pdf}`);
    const a = await sign(v, SECOND, { match: pdfPost, answer: () => new Response("", { status: 500 }), later: true });
    expect(a.ok).toBe(false);
    expect((await sign(v, ORIGINAL)).ok, "B signs once A's claim is released").toBe(true);
    const late = await state.kept.shift()!();
    expect(late, "A's late PDF write is refused, never overwrites").not.toBe(200);
    const o = await observe(v);
    expectIntact(o);
    expect(o.pngSha).toBe(sha(ORIGINAL));
  });

  it("the insert landed, its answer lost: the slip is recorded, its files kept", async () => {
    const v = await newViewing();
    const r = await sign(v, ORIGINAL, { match: (m, u) => m === "POST" && u.includes("/rest/v1/viewing_slips"), answer: ANSWERS["200 empty"].answer });
    expect(r.hits).toHaveLength(1);
    expect(r.error).toBeNull();
    expectIntact(await observe(v));
  });

  it("the organisation could not be read: refused before anything is stored — never a PDF saying 'Agency'", async () => {
    const v = await newViewing();
    const r = await sign(v, ORIGINAL, { match: (m, u) => m === "GET" && u.includes("/rest/v1/organizations?"), answer: ANSWERS["200 empty"].answer });
    expect(r.hits).toHaveLength(1);
    expect(r).toMatchObject({ error: "Could not read your organisation — nothing was changed. Try again.", ok: false, adminWrites: [], sessionWrites: [] });
    expect((await observe(v)).rows).toBe(0);
    // the control: the PDF names the organisation
    expect((await sign(v, ORIGINAL)).ok).toBe(true);
    const { data } = await svc.storage.from("signatures").download(paths(v).pdf);
    expect(extractPdfText(Buffer.from(await data!.arrayBuffer()))).toContain(`Slip null answers ${RUN}`);
  });
});

// ---------------------------------------------------------------- INT-08
describe("files an unfinished attempt stranded never block a viewing for good (INT-08)", () => {
  async function strand(v: string, ageMinutes: number) {
    const junk = Buffer.from("stranded by an attempt that died");
    const { error } = await svc.storage.from("signatures").upload(paths(v).png, new Blob([junk], { type: "image/png" }));
    if (error) throw new Error(`strand: ${error.message}`);
    if (ageMinutes > 0) {
      await pg.query("update storage.objects set created_at = now() - make_interval(mins => $2) where bucket_id = 'signatures' and name = $1", [paths(v).png, ageMinutes]);
    }
    return sha(junk);
  }

  it("stranded long ago, no slip: cleared — and the next signing is intact", async () => {
    const v = await newViewing();
    await strand(v, 30);
    const r = await sign(v, ORIGINAL);
    expect(r).toMatchObject({ error: "An earlier signing that did not finish had left files behind; they have been cleared. Please sign again.", ok: false });
    expect((await observe(v)).objectIds).toEqual([]);
    expect((await sign(v, ORIGINAL)).ok).toBe(true);
    const o = await observe(v);
    expectIntact(o);
    expect(o.pngSha).toBe(sha(ORIGINAL));
  });

  it("files a live attempt may still own: 'in progress' — nothing removed", async () => {
    const v = await newViewing();
    const planted = await strand(v, 0);
    const r = await sign(v, ORIGINAL);
    expect(r).toMatchObject({ error: "Another signing of this viewing is in progress, or one that did not finish left its files — try again in 5 minutes.", ok: false });
    expect(await objSha(paths(v).png), "the other attempt's file is kept").toBe(planted);
    expect((await observe(v)).rows).toBe(0);
  });
});

// ---------------------------------------------------------------- the pages
type Element = ReactElement<Record<string, unknown>>;
function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const x of node) yield* walk(x);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as Element;
  yield el;
  yield* walk(el.props.children);
}

describe("the pages never offer the pad over a signed slip on an unclear answer", () => {
  async function signedFixture() {
    const v = await newViewing();
    await pg.query("insert into viewing_slips (org_id, viewing_id, signer_name, signature_path, signature_sha256) values ($1, $2, 'Page Signer', $3, $4)", [ORG, v, paths(v).png, "0".repeat(64)]);
    return v;
  }
  async function render(page: () => Promise<unknown>, fault: Fault | null) {
    state.hits = [];
    state.fault = fault;
    state.queue.push(await session());
    try {
      const els = [...walk((await page()) as ReactNode)];
      return { els, thrown: null as string | null, hits: [...state.hits] };
    } catch (e) {
      return { els: [] as Element[], thrown: e instanceof Error ? e.message : String(e), hits: [...state.hits] };
    } finally {
      state.fault = null;
    }
  }

  it("the sign page: the slip read answered empty — the page fails by name, never shows the pad", async () => {
    const v = await signedFixture();
    const page = () => SignSlipPage({ params: Promise.resolve({ id: v }) });
    const control = await render(page, null);
    expect(control.thrown).toBeNull();
    expect(control.els.some((e) => e.type === SlipDownloadButton), "the control shows the signed slip").toBe(true);
    expect(control.els.some((e) => e.type === SignSlip)).toBe(false);
    const r = await render(page, { match: slipCheck(v), answer: ANSWERS["200 empty"].answer });
    expect(r.hits).toHaveLength(1);
    expect(r.thrown).toBe("Query failed (viewing slip): the answer held no rows (HTTP 200)");
  });

  it("the viewing page: the slip read answered empty — the page fails by name, never says 'Not signed yet'", async () => {
    const v = await signedFixture();
    const page = () => ViewingDetailPage({ params: Promise.resolve({ id: v }) });
    const control = await render(page, null);
    expect(control.thrown).toBeNull();
    expect(control.els.some((e) => e.type === SlipDownloadButton), "the control shows the signed slip").toBe(true);
    const r = await render(page, { match: slipCheck(v), answer: ANSWERS["200 empty"].answer });
    expect(r.hits).toHaveLength(1);
    expect(r.thrown).toBe("Query failed (viewing slip): the answer held no rows (HTTP 200)");
  });
});
