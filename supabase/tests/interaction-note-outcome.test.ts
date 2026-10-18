import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import { anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { BODY_MD5_0155, LOG_CONVERSATION_0094, LOG_CONVERSATION_0155, REVERT_0155_SQL, readMigration0155 } from "./revert-0155";

/**
 * 0155 (A06-b): a logged conversation says what happened — the desk spoke to
 * the person, sent a message that has had no reply yet, or the client replied.
 *
 *   1. over PostgREST, as a signed-in agent at aal2: the DEPLOYED application's
 *      call (four named arguments) still logs, with no outcome and 0094's
 *      payload — so the migration may go to hosted before the application;
 *      each outcome lands on the note and in its conversation_logged event; a
 *      word that is not one is refused and writes nothing, through the
 *      function and straight into the table; nobody rewrites an outcome
 *      (a session has no UPDATE, postgres and the service role meet the
 *      trigger) and a redaction keeps it; exactly one log_conversation.
 *   2. the three dialogs' REAL actions — the inbox's logConversation, a
 *      contact's logContactConversation, a deal's logDealContact — with and
 *      without a note: the outcome reaches the chain either way, the clock
 *      rules do not look at it (the lead's first response is stamped, the
 *      deal's last contact moves, whatever was said), a form without the
 *      field logs no outcome, a word that is not one is refused in words
 *      before anything is written; the contact strip's last contact says it.
 *   3. the migration: replay over the state before it, its shape, the
 *      one-transaction guard, the preflight refusing what it was not written
 *      against, a bounded lock wait, replay safety, postflight mutants, the
 *      rollback, the restore pack's row, and the chain still verifying.
 *
 * Measured against the iso stack with 0155 reverted (2026-10-18): sections 1
 * and 2 read 15 failed / 5 passed. Every test that sends or reads an outcome
 * through the database is RED (the function has no p_outcome: PGRST202; the
 * table has no column; the one function there is 0094's). What passes
 * there is what never needed the migration: the deployed four-argument call
 * (the control), and the application-only paths — the no-note event written
 * by logEvent, a form without the field, and the refusals in words. Section 3
 * has no 0155 to find. Throwaway organisation, deleted at the end as
 * postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const state = vi.hoisted(() => ({ queue: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
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

import { logConversation } from "@/lib/actions/leads";
import { logContactConversation } from "@/lib/actions/contacts";
import { logDealContact } from "@/lib/actions/deals";
import { describeEvent, type EventTranslator } from "@/lib/services/events";
import { readContactActivitySummary } from "@/lib/services/contact-activity-summary";

const enT = createTranslator({ locale: "en", messages: en, namespace: "events" });
const t = ((key, values) => enT(key as never, values as never)) as EventTranslator;
const line = (entityType: string, payload: unknown) =>
  describeEvent({ entity_type: entityType, event_type: "conversation_logged", payload: payload as never }, t);

let svc: SupabaseClient;
let o: Client; // postgres: observation, fixtures, the migration replays, cleanup
let a: Client; // a second session holding a lock
let agent: TestUser;
let contact: string;
let lead: string;
let freshLead: string;
let deal: string;

type PgError = Error & { code?: string; constraint?: string };
const failure = (q: Promise<unknown>) =>
  q.then(
    () => null,
    (e: PgError) => e,
  );

async function one<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T> {
  return (await o.query(sql, args)).rows[0] as T;
}

/**
 * The note row and its conversation_logged event, read as postgres. The
 * outcome is read through to_jsonb so the same read answers (null) on a
 * database without the column — the deployed-call control below then means
 * the same thing before and after 0155.
 */
async function noteAndEvent(noteId: string) {
  const note = await one<{ outcome: string | null; channel: string; body: string | null; entity_type: string }>(
    "select to_jsonb(n) ->> 'outcome' as outcome, n.channel::text as channel, n.body, n.entity_type from interaction_notes n where n.id = $1",
    [noteId],
  );
  const event = await one<{ payload: Record<string, unknown>; actor_id: string | null; entity_type: string }>(
    "select payload, actor_id, entity_type from events where org_id = $1 and event_type = 'conversation_logged' and payload ->> 'note_id' = $2",
    [ORG, noteId],
  );
  return { note, event };
}

/** the newest conversation_logged event on one record */
async function newestLogged(entityId: string) {
  return one<{ id: string; payload: Record<string, unknown>; actor_id: string | null }>(
    "select id, payload, actor_id from events where org_id = $1 and entity_id = $2 and event_type = 'conversation_logged' order by id desc limit 1",
    [ORG, entityId],
  );
}

const counts = async () =>
  one<{ notes: number; events: number }>(
    `select (select count(*)::int from interaction_notes where org_id = $1) as notes,
            (select count(*)::int from events where org_id = $1 and event_type = 'conversation_logged') as events`,
    [ORG],
  );

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  a = new Client({ connectionString: DB_URL });
  await o.connect();
  await a.connect();
  await ensureTestOrg(svc, ORG, `Outcome ${RUN}`, `outcome-${RUN}`);
  agent = await createTestUser(svc, `outcome-agent-${RUN}@test.local`, "agent", ORG);

  const stage = (
    await one<{ id: string }>(
      "select id from deal_stages where org_id = $1 and deal_type = 'sale' and not is_won and not is_lost order by sort_order limit 1",
      [ORG],
    )
  ).id;
  contact = (await one<{ id: string }>("insert into contacts (org_id, first_name) values ($1, $2) returning id", [ORG, `ZZOutcome ${RUN}`])).id;
  // a phoned-in lead for the person, assigned to the agent, never answered
  lead = (
    await one<{ id: string }>(
      "insert into leads (org_id, source, message, contact_id, assigned_agent_id) values ($1, 'phone', $2, $3, $4) returning id",
      [ORG, `ZZOutcome enquiry ${RUN}`, contact, agent.id],
    )
  ).id;
  // a second unanswered lead the refusals must leave unanswered
  freshLead = (
    await one<{ id: string }>(
      "insert into leads (org_id, source, message, contact_id, assigned_agent_id) values ($1, 'phone', $2, $3, $4) returning id",
      [ORG, `ZZOutcome second enquiry ${RUN}`, contact, agent.id],
    )
  ).id;
  deal = (
    await one<{ id: string }>(
      `insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by, buyer_contact_id, last_contact_at, last_activity_at)
       values ($1, 'sale', $2, $3, $4, $4, $5, '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z') returning id`,
      [ORG, stage, `ZZOutcome deal ${RUN}`, agent.id, contact],
    )
  ).id;
});

afterAll(async () => {
  for (const tbl of ["interaction_notes", "notification_jobs", "tasks", "leads", "deals", "contacts"]) {
    await o.query(`delete from ${tbl} where org_id = $1`, [ORG]);
  }
  if (agent) await svc.auth.admin.deleteUser(agent.id);
  for (const tbl of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await o.query(`delete from ${tbl} where org_id = $1`, [ORG]);
  }
  await o.query("delete from organizations where id = $1", [ORG]);
  await a.end();
  await o.end();
});

describe("1. over PostgREST, as a signed-in agent", () => {
  it("the deployed application's call — four named arguments — still logs, with no outcome and 0094's payload", async () => {
    const body = `deployed call ${RUN}`;
    const { data, error } = await agent.client.rpc("log_conversation", {
      p_entity_type: "contact",
      p_entity_id: contact,
      p_channel: "phone",
      p_note: body,
    });
    expect(error, error?.message).toBeNull();
    const { note, event } = await noteAndEvent(data as string);
    expect(note.outcome, "not said").toBeNull();
    expect(Object.keys(event.payload).sort(), "chained exactly as 0094 chained it").toEqual(["channel", "note_id", "note_sha256"]);
    expect(event.payload.note_sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(event.actor_id).toBe(agent.id);
    expect(line("contact", event.payload)).toBe("Conversation logged (Phone)");
  });

  it.each([
    ["spoke", "Conversation logged (WhatsApp)"],
    ["message_sent", "Message sent (WhatsApp)"],
    ["client_replied", "Client replied (WhatsApp)"],
  ])("%s lands on the note and in its event, and reads %j", async (outcome, words) => {
    const { data, error } = await agent.client.rpc("log_conversation", {
      p_entity_type: "lead",
      p_entity_id: lead,
      p_channel: "whatsapp",
      p_note: `${outcome} ${RUN}`,
      p_outcome: outcome,
    });
    expect(error, error?.message).toBeNull();
    const { note, event } = await noteAndEvent(data as string);
    expect(note.outcome).toBe(outcome);
    expect(event.payload).toMatchObject({ channel: "whatsapp", outcome });
    expect(event.entity_type).toBe("lead");
    expect(JSON.stringify(event.payload), "the note's words never enter the chain").not.toContain(RUN);
    expect(line("lead", event.payload)).toBe(words);
  });

  it.each(["replied", "MESSAGE_SENT", " spoke", "", "seen"])("a word that is not an outcome (%j) is refused and writes nothing", async (outcome) => {
    const before = await counts();
    const { error } = await agent.client.rpc("log_conversation", {
      p_entity_type: "contact",
      p_entity_id: contact,
      p_channel: "phone",
      p_note: `refused ${RUN}`,
      p_outcome: outcome,
    });
    expect(error?.code, error?.message).toBe("23514");
    expect(await counts()).toEqual(before);
  });

  it("a session inserting a note straight into the table is held to the same words, and the trigger chains a good one", async () => {
    const row = { org_id: ORG, entity_type: "contact", entity_id: contact, channel: "sms", body: `direct ${RUN}`, created_by: agent.id };
    const bad = await agent.client.from("interaction_notes").insert({ ...row, outcome: "seen" });
    expect(bad.error?.code, bad.error?.message).toBe("23514");
    expect(bad.error?.message).toContain("interaction_notes_outcome_check");

    const good = await agent.client.from("interaction_notes").insert({ ...row, outcome: "client_replied" }).select("id").single();
    expect(good.error, good.error?.message).toBeNull();
    const { event } = await noteAndEvent(good.data!.id as string);
    expect(event.payload).toMatchObject({ channel: "sms", outcome: "client_replied" });
  });

  it("nobody rewrites an outcome — a session has no UPDATE, postgres and the service role meet the trigger — and a redaction keeps it", async () => {
    const { data: id } = await agent.client.rpc("log_conversation", {
      p_entity_type: "deal",
      p_entity_id: deal,
      p_channel: "email",
      p_note: `immutable ${RUN}`,
      p_outcome: "message_sent",
    });
    const noteId = id as string;

    const bySession = await agent.client.from("interaction_notes").update({ outcome: "client_replied" }).eq("id", noteId).select("id");
    expect(bySession.error !== null || (bySession.data ?? []).length === 0, "the session's update did nothing").toBe(true);

    const byService = await svc.from("interaction_notes").update({ outcome: "client_replied" }).eq("id", noteId);
    expect(byService.error?.code, byService.error?.message).toBe("23514");
    expect(byService.error?.message).toMatch(/outcome is immutable/);

    for (const to of ["client_replied", null]) {
      const e = await failure(o.query("update interaction_notes set outcome = $2 where id = $1", [noteId, to]));
      expect(e?.code, e?.message ?? `postgres rewrote it to ${to}`).toBe("23514");
    }
    expect((await noteAndEvent(noteId)).note.outcome, "asked of the database, not the reader").toBe("message_sent");

    // erasure's and the retention sweep's write: the text goes, the outcome stays
    const redact = await svc.from("interaction_notes").update({ body: null, redacted_at: new Date().toISOString() }).eq("id", noteId);
    expect(redact.error, redact.error?.message).toBeNull();
    expect((await noteAndEvent(noteId)).note).toMatchObject({ body: null, outcome: "message_sent" });
  });

  it("exactly one log_conversation exists — SECURITY INVOKER — and anon may not call it", async () => {
    const { rows } = await o.query<{ sig: string; secdef: boolean }>(
      "select oid::regprocedure::text as sig, prosecdef as secdef from pg_proc where pronamespace = 'public'::regnamespace and proname = 'log_conversation'",
    );
    expect(rows).toEqual([{ sig: "log_conversation(text,uuid,comm_channel,text,text)", secdef: false }]);
    const res = await anonClient().rpc("log_conversation", {
      p_entity_type: "contact",
      p_entity_id: contact,
      p_channel: "phone",
      p_note: "anon",
      p_outcome: "spoke",
    });
    expect(res.error).not.toBeNull();
  });
});

describe("2. the three dialogs' actions, for real", () => {
  it("the inbox's Log: Message sent still stamps the lead's first response, and the event says what happened", async () => {
    expect((await one<{ fr: Date | null }>("select first_response_at as fr from leads where id = $1", [lead])).fr).toBeNull();
    state.queue.push(agent.client);
    const res = await logConversation(
      { error: null, savedAt: null },
      form({ lead_id: lead, channel: "whatsapp", note: `sent the brochure ${RUN}`, outcome: "message_sent" }),
    );
    expect(res.error).toBeNull();
    const l = await one<{ fr: Date | null; status: string }>("select first_response_at as fr, status::text as status from leads where id = $1", [lead]);
    expect(l.fr, "a logged conversation is the agency's response, whatever it says").not.toBeNull();
    expect(l.status).toBe("contacted");
    const ev = await newestLogged(lead);
    expect(ev.payload).toMatchObject({ channel: "whatsapp", outcome: "message_sent" });
    expect(ev.actor_id).toBe(agent.id);
    expect((await noteAndEvent(ev.payload.note_id as string)).note.outcome).toBe("message_sent");
  });

  it("a contact's Log contact with no note: the event alone carries {channel, outcome}", async () => {
    const before = await counts();
    state.queue.push(agent.client);
    const res = await logContactConversation({ error: null, savedAt: null }, form({ contact_id: contact, channel: "phone", outcome: "client_replied" }));
    expect(res.error).toBeNull();
    const ev = await newestLogged(contact);
    expect(ev.payload, "the trigger's shape, without a note").toEqual({ channel: "phone", outcome: "client_replied" });
    expect(ev.actor_id).toBe(agent.id);
    const after = await counts();
    expect(after.notes, "no note row without a note").toBe(before.notes);
    expect(line("contact", ev.payload)).toBe("Client replied (Phone)");
  });

  it("a contact's Log contact with a note and Spoke: the note and its event say so", async () => {
    state.queue.push(agent.client);
    const res = await logContactConversation(
      { error: null, savedAt: null },
      form({ contact_id: contact, channel: "in_person", note: `met at the office ${RUN}`, outcome: "spoke" }),
    );
    expect(res.error).toBeNull();
    const ev = await newestLogged(contact);
    expect(ev.payload).toMatchObject({ channel: "in_person", outcome: "spoke" });
    expect((await noteAndEvent(ev.payload.note_id as string)).note.outcome).toBe("spoke");
    expect(line("contact", ev.payload)).toBe("Conversation logged (In person)");
  });

  it("a form without the field (a page from before 0155) logs no outcome — never a default", async () => {
    state.queue.push(agent.client);
    expect((await logContactConversation({ error: null, savedAt: null }, form({ contact_id: contact, channel: "email" }))).error).toBeNull();
    expect((await newestLogged(contact)).payload).toEqual({ channel: "email" });

    state.queue.push(agent.client);
    expect(
      (await logContactConversation({ error: null, savedAt: null }, form({ contact_id: contact, channel: "email", note: `old form ${RUN}` }))).error,
    ).toBeNull();
    const ev = await newestLogged(contact);
    expect(Object.keys(ev.payload).sort()).toEqual(["channel", "note_id", "note_sha256"]);
  });

  it("a deal's Log contact with no note: Message sent moves last_contact_at like any logged contact", async () => {
    state.queue.push(agent.client);
    const res = await logDealContact({ error: null, savedAt: null }, form({ deal_id: deal, channel: "whatsapp", outcome: "message_sent" }));
    expect(res.error).toBeNull();
    const d = await one<{ last_contact_at: Date }>("select last_contact_at from deals where id = $1", [deal]);
    expect(d.last_contact_at.getTime(), "the no-contact nudge is silenced by a logged contact, whatever it says").toBeGreaterThan(
      Date.parse("2026-01-02T10:00:00Z"),
    );
    expect((await newestLogged(deal)).payload).toEqual({ channel: "whatsapp", outcome: "message_sent" });
  });

  it("a deal's Log contact with a note: Client replied on the note and in its event", async () => {
    state.queue.push(agent.client);
    const res = await logDealContact(
      { error: null, savedAt: null },
      form({ deal_id: deal, channel: "phone", note: `they called back ${RUN}`, outcome: "client_replied" }),
    );
    expect(res.error).toBeNull();
    const ev = await newestLogged(deal);
    expect(ev.payload).toMatchObject({ channel: "phone", outcome: "client_replied" });
    expect((await noteAndEvent(ev.payload.note_id as string)).note.outcome).toBe("client_replied");
  });

  it("a word that is not an outcome is refused in words by all three, before anything is written", async () => {
    const before = await counts();
    const dealBefore = await one<{ last_contact_at: Date }>("select last_contact_at from deals where id = $1", [deal]);
    for (const outcome of ["seen", "MESSAGE_SENT"]) {
      // no client is queued: a refusal must come before the action reads anything
      const leadRes = await logConversation({ error: null, savedAt: null }, form({ lead_id: freshLead, channel: "phone", note: "x", outcome }));
      const contactRes = await logContactConversation({ error: null, savedAt: null }, form({ contact_id: contact, channel: "phone", outcome }));
      expect(leadRes.error).toBe("Choose what happened");
      expect(contactRes.error).toBe("Choose what happened");
      state.queue.push(agent.client); // logDealContact signs in before it parses
      const dealRes = await logDealContact({ error: null, savedAt: null }, form({ deal_id: deal, channel: "phone", outcome }));
      expect(dealRes.error).toBe("Choose what happened");
    }
    expect(state.queue).toEqual([]);
    expect(await counts()).toEqual(before);
    expect((await one<{ fr: Date | null }>("select first_response_at as fr from leads where id = $1", [freshLead])).fr).toBeNull();
    expect((await one<{ last_contact_at: Date }>("select last_contact_at from deals where id = $1", [deal])).last_contact_at).toEqual(
      dealBefore.last_contact_at,
    );
  });

  it("the contact strip's last logged contact carries what happened", async () => {
    const s = await readContactActivitySummary({
      orgId: ORG,
      viewer: agent.client as never,
      contactId: contact,
      contactIds: [contact],
      leadIds: [lead, freshLead],
      dealIds: [deal],
      now: new Date(),
    });
    expect(s.lastContact.ok && s.lastContact.value?.entity_type).toBe("deal");
    expect(s.lastContact.ok && s.lastContact.value?.payload).toEqual({ channel: "phone", outcome: "client_replied" });
    if (s.lastContact.ok && s.lastContact.value) expect(describeEvent(s.lastContact.value, t)).toBe("Client replied (Phone)");
  });
});

describe("3. the migration", () => {
  /** Run `body` in a transaction on `o` that is always ROLLED BACK; collects the NOTICEs it raises. */
  async function rolledBack(body: (notices: string[]) => Promise<void>) {
    const notices: string[] = [];
    const onNotice = (m: { message?: string }) => {
      if (m.message) notices.push(m.message);
    };
    o.on("notice", onNotice);
    await o.query("begin");
    try {
      await body(notices);
    } finally {
      await o.query("rollback");
      o.off("notice", onNotice);
    }
  }
  const lastRow = (res: unknown) => {
    const results = (Array.isArray(res) ? res : [res]) as { rows: Record<string, unknown>[] }[];
    return results[results.length - 1]!.rows[0]!;
  };
  const bodyMd5 = async (sig: string) =>
    (
      await o.query<{ md5: string | null }>("select md5(replace(prosrc, chr(13), '')) as md5 from pg_proc where oid = to_regprocedure($1)", [sig])
    ).rows[0]?.md5 ?? null;
  const hasOutcome = async () =>
    (
      await o.query<{ c: number }>(
        "select count(*)::int as c from pg_attribute where attrelid = 'public.interaction_notes'::regclass and attname = 'outcome' and not attisdropped",
      )
    ).rows[0]!.c === 1;
  const signatures = async () =>
    (
      await o.query<{ sig: string }>(
        "select oid::regprocedure::text as sig from pg_proc where pronamespace = 'public'::regnamespace and proname = 'log_conversation' order by 1",
      )
    ).rows.map((r) => r.sig);
  const BEFORE_STATE = async () => {
    expect(await hasOutcome()).toBe(false);
    expect(await signatures()).toEqual(["log_conversation(text,uuid,comm_channel,text)"]);
  };

  it("replays over the state before it: preflight and postflight pass, the bodies are 0155's, the summary is its last row", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0155_SQL);
      await BEFORE_STATE();
      expect(await bodyMd5(LOG_CONVERSATION_0094)).toBe(BODY_MD5_0155.log_conversation.before);
      expect(await bodyMd5("public.trg_interaction_notes_before()")).toBe(BODY_MD5_0155.trg_interaction_notes_before.before);
      expect(await bodyMd5("public.trg_interaction_notes_after_insert()")).toBe(BODY_MD5_0155.trg_interaction_notes_after_insert.before);

      const row = lastRow(await o.query(readMigration0155()));
      expect(String(row.summary)).toMatch(/^0155 applied — interaction_notes\.outcome: \d+ note\(s\) not said, 0 with an outcome$/);
      expect(await hasOutcome()).toBe(true);
      expect(await signatures()).toEqual(["log_conversation(text,uuid,comm_channel,text,text)"]);
      expect(await bodyMd5(LOG_CONVERSATION_0155)).toBe(BODY_MD5_0155.log_conversation.after);
      expect(await bodyMd5("public.trg_interaction_notes_before()")).toBe(BODY_MD5_0155.trg_interaction_notes_before.after);
      expect(await bodyMd5("public.trg_interaction_notes_after_insert()")).toBe(BODY_MD5_0155.trg_interaction_notes_after_insert.after);
      expect(notices.some((m) => m.startsWith("0155: postflight passed"))).toBe(true);
    });
  });

  it("its shape: every abort and the lock precede the first DDL, the CHECK is added NOT VALID then VALIDATEd, the only writes are the postflight's undone probe, no begin/commit", () => {
    const code = readMigration0155().replace(/--[^\n]*/g, "");
    const firstDdl = code.search(/\balter table public\.interaction_notes add column\b/i);
    expect(firstDdl).toBeGreaterThan(0);
    const aborts = [...code.matchAll(/raise exception '0155 aborted/g)].map((m) => m.index!);
    expect(aborts.length).toBeGreaterThanOrEqual(10);
    for (const at of aborts) expect(at).toBeLessThan(firstDdl);
    const lock = code.indexOf("lock table public.interaction_notes in access exclusive mode;");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(aborts[1]!);
    const added = code.indexOf(
      "add constraint interaction_notes_outcome_check\n  check (outcome is null or outcome in ('spoke', 'message_sent', 'client_replied')) not valid;",
    );
    const validated = code.indexOf("validate constraint interaction_notes_outcome_check;");
    expect(added).toBeGreaterThan(firstDdl);
    expect(validated).toBeGreaterThan(added);
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(code).not.toMatch(/\b(delete from|truncate)\b/i);
    // the first DO block after the VALIDATE is the postflight; its probe is the only writer
    const postflight = code.indexOf("do $$", validated);
    const probe = code.indexOf("insert into public.organizations");
    expect(postflight).toBeGreaterThan(validated);
    expect(probe).toBeGreaterThan(postflight);
    for (const m of code.matchAll(/\b(update|insert into)\s+public\./gi)) {
      expect(m.index!, `${m[0]} outside the postflight's undone probe`).toBeGreaterThanOrEqual(probe);
      expect(m.index!).toBeLessThan(code.indexOf("'0155-postflight-undo'"));
    }
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0155();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/^0155 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  const refusals: Array<[string, string, RegExp]> = [
    [
      "a trg_interaction_notes_before body it was not written against",
      `create or replace function public.trg_interaction_notes_before() returns trigger language plpgsql
       set search_path = public as $fn$ begin return new; end $fn$;`,
      /^0155 aborted: the body of public\.trg_interaction_notes_before\(\) is not 0094's \(md5 [0-9a-f]{32}\) — read it before replacing it; nothing was changed$/,
    ],
    [
      "an AFTER trigger function that became SECURITY DEFINER",
      "alter function public.trg_interaction_notes_after_insert() security definer",
      /^0155 aborted: public\.trg_interaction_notes_after_insert\(\) is not the SECURITY INVOKER trigger function owned by postgres/,
    ],
    [
      "a trigger function a session may call",
      "grant execute on function public.trg_interaction_notes_before() to authenticated",
      /^0155 aborted: anon or authenticated may execute public\.trg_interaction_notes_before\(\)/,
    ],
    [
      "a log_conversation body it was not written against",
      `create or replace function public.log_conversation(p_entity_type text, p_entity_id uuid, p_channel public.comm_channel, p_note text)
       returns uuid language plpgsql security invoker set search_path = public as $fn$ begin return null; end $fn$;`,
      /^0155 aborted: the body of public\.log_conversation is not 0094's \(md5 [0-9a-f]{32}\)/,
    ],
    [
      "a log_conversation that became SECURITY DEFINER",
      "alter function public.log_conversation(text, uuid, public.comm_channel, text) security definer",
      /^0155 aborted: public\.log_conversation is not the SECURITY INVOKER uuid function owned by postgres/,
    ],
    [
      "a second log_conversation beside 0094's",
      `create function public.log_conversation(p_entity_type text, p_entity_id uuid) returns uuid language sql as $fn$ select null::uuid $fn$;`,
      /^0155 aborted: there are 2 functions named public\.log_conversation; this file replaces exactly one/,
    ],
    [
      "a log_conversation anon may call",
      "grant execute on function public.log_conversation(text, uuid, public.comm_channel, text) to anon",
      /^0155 aborted: the grants on public\.log_conversation are not authenticated \+ service_role without anon or PUBLIC/,
    ],
    [
      "a disabled note trigger",
      "alter table public.interaction_notes disable trigger interaction_notes_after_insert",
      /^0155 aborted: public\.interaction_notes does not carry 0094's two enabled row triggers/,
    ],
    [
      "an outcome column of another type",
      "alter table public.interaction_notes add column outcome integer",
      /^0155 aborted: public\.interaction_notes is not 0094's table \(0 of its columns changed or missing, 1 unknown\)/,
    ],
    [
      "a column it does not know",
      "alter table public.interaction_notes add column mood text",
      /^0155 aborted: public\.interaction_notes is not 0094's table \(0 of its columns changed or missing, 1 unknown\)/,
    ],
    [
      "a session that may update notes",
      "grant update on public.interaction_notes to authenticated",
      /^0155 aborted: the grants on public\.interaction_notes are wider than 0094's/,
    ],
  ];
  for (const [label, setup, refusal] of refusals) {
    it(`the preflight refuses ${label}, changing nothing`, async () => {
      await rolledBack(async () => {
        await o.query(REVERT_0155_SQL);
        await o.query(setup);
        await o.query("savepoint before_0155");
        const e = await failure(o.query(readMigration0155()));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0155");
        expect(await signatures()).toContain("log_conversation(text,uuid,comm_channel,text)");
        expect(await signatures()).not.toContain("log_conversation(text,uuid,comm_channel,text,text)");
      });
    });
  }

  it("a note being written makes it wait at most lock_timeout, then abort (55P03), changing nothing", async () => {
    await a.query("begin");
    await a.query("lock table public.interaction_notes in row exclusive mode");
    try {
      await rolledBack(async () => {
        const t0 = Date.now();
        const e = await failure(o.query(readMigration0155()));
        const waited = Date.now() - t0;
        expect(e?.code, e?.message).toBe("55P03");
        expect(waited).toBeGreaterThanOrEqual(4_500);
        expect(waited).toBeLessThan(15_000);
      });
    } finally {
      await a.query("rollback");
    }
    expect(await hasOutcome()).toBe(true);
  });

  it("is replay-safe: run twice in one transaction, one validated CHECK, one function, 0155's bodies", async () => {
    await rolledBack(async (notices) => {
      await o.query(readMigration0155());
      await o.query(readMigration0155());
      const { rows } = await o.query<{ c: number }>(
        "select count(*)::int as c from pg_constraint where conrelid = 'public.interaction_notes'::regclass and conname = 'interaction_notes_outcome_check' and convalidated",
      );
      expect(rows[0]!.c).toBe(1);
      expect(await signatures()).toEqual(["log_conversation(text,uuid,comm_channel,text,text)"]);
      expect(await bodyMd5(LOG_CONVERSATION_0155)).toBe(BODY_MD5_0155.log_conversation.after);
      expect(notices.filter((m) => m.startsWith("0155: postflight passed"))).toHaveLength(2);
    });
  });

  const mutants: Array<[string, (sql: string) => string, RegExp]> = [
    [
      "an AFTER trigger that leaves the outcome out of the payload",
      (s) =>
        s.replace(
          "                             'note_sha256', new.body_sha256)\n          || case when new.outcome is null then '{}'::jsonb\n                  else jsonb_build_object('outcome', new.outcome) end);",
          () => "                             'note_sha256', new.body_sha256));",
        ),
      /^0155 postflight: the conversation_logged event of a note with an outcome does not carry it$/,
    ],
    [
      "an AFTER trigger that always writes the key",
      (s) =>
        s.replace(
          "          || case when new.outcome is null then '{}'::jsonb\n                  else jsonb_build_object('outcome', new.outcome) end);",
          () => "          || jsonb_build_object('outcome', new.outcome));",
        ),
      /^0155 postflight: a conversation logged without an outcome is not chained as 0094 chained it \(outcome <NULL>, payload keys \{channel,note_id,note_sha256,outcome\}\)$/,
    ],
    [
      "a BEFORE trigger without the outcome guard",
      (s) =>
        s.replace(
          "  if new.outcome is distinct from old.outcome then\n    raise exception 'interaction_notes: a note''s outcome is immutable — log the conversation again instead'\n      using errcode = 'check_violation';\n  end if;\n",
          "",
        ),
      /^0155 postflight: a note's outcome could be rewritten$/,
    ],
    [
      "a log_conversation that drops the outcome",
      (s) =>
        s.replace(
          "  values (v_org, p_entity_type, p_entity_id, p_channel, btrim(p_note), p_outcome)",
          () => "  values (v_org, p_entity_type, p_entity_id, p_channel, btrim(p_note), null)",
        ),
      /^0155 postflight: log_conversation did not store the outcome on the note \(read <NULL>\)$/,
    ],
    [
      "a log_conversation without its own check — the table's CHECK still refuses, but it is not the body this file pins",
      (s) =>
        s.replace(
          "  if p_outcome is not null and p_outcome not in ('spoke', 'message_sent', 'client_replied') then\n    raise exception 'log_conversation: the outcome must be spoke, message_sent or client_replied'\n      using errcode = 'check_violation';\n  end if;\n",
          "",
        ),
      /^0155 postflight: the trigger functions and log_conversation are not the SECURITY INVOKER bodies this file wrote$/,
    ],
    [
      "a looser CHECK",
      (s) =>
        s.replace(
          "check (outcome is null or outcome in ('spoke', 'message_sent', 'client_replied')) not valid;",
          () => "check (outcome is null or outcome in ('spoke', 'message_sent', 'client_replied', 'other')) not valid;",
        ),
      /^0155 postflight: public\.interaction_notes does not carry the validated CHECK interaction_notes_outcome_check$/,
    ],
    [
      "a CHECK left NOT VALID",
      (s) => s.replace("alter table public.interaction_notes validate constraint interaction_notes_outcome_check;\n", ""),
      /^0155 postflight: public\.interaction_notes does not carry the validated CHECK interaction_notes_outcome_check$/,
    ],
    [
      "0094's function not dropped first — an overload beside it",
      (s) => s.replace("drop function if exists public.log_conversation(text, uuid, public.comm_channel, text);\n", ""),
      /^0155 postflight: public\.log_conversation is not the one five-argument function with p_outcome DEFAULT NULL$/,
    ],
    [
      "a function anon may call",
      (s) =>
        s.replace(
          "grant  execute on function public.log_conversation(text, uuid, public.comm_channel, text, text) to authenticated, service_role;",
          "grant  execute on function public.log_conversation(text, uuid, public.comm_channel, text, text) to authenticated, service_role, anon;",
        ),
      /^0155 postflight: the grants on public\.log_conversation are not authenticated \+ service_role without anon or PUBLIC$/,
    ],
  ];
  for (const [label, mutate, refusal] of mutants) {
    it(`the postflight refuses ${label}`, async () => {
      const sql = readMigration0155();
      const bad = mutate(sql);
      expect(bad, "the mutation installed").not.toBe(sql);
      await rolledBack(async () => {
        await o.query(REVERT_0155_SQL);
        await o.query("savepoint before_0155");
        const e = await failure(o.query(bad));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0155");
        await BEFORE_STATE();
      });
    });
  }

  it("the rollback recipe leaves 0094's state: its function, its bodies, no column — and the deployed call still logs", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0155_SQL);
      await BEFORE_STATE();
      expect(await bodyMd5(LOG_CONVERSATION_0094)).toBe(BODY_MD5_0155.log_conversation.before);
      expect(await bodyMd5("public.trg_interaction_notes_before()")).toBe(BODY_MD5_0155.trg_interaction_notes_before.before);
      expect(await bodyMd5("public.trg_interaction_notes_after_insert()")).toBe(BODY_MD5_0155.trg_interaction_notes_after_insert.before);
      const { rows } = await o.query<{ anon: boolean; auth: boolean; svc: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc`,
        [LOG_CONVERSATION_0094],
      );
      expect(rows[0]).toEqual({ anon: false, auth: true, svc: true });

      await o.query("savepoint five");
      const e = await failure(o.query("select public.log_conversation('contact', $1, 'phone', 'x', 'spoke')", [contact]));
      expect(e?.code, "the new application's call fails closed against the old function").toBe("42883");
      await o.query("rollback to savepoint five");

      const id = (await one<{ id: string }>("select public.log_conversation('contact', $1, 'phone', $2) as id", [contact, `rolled back ${RUN}`])).id;
      // the column is gone, so the event is read on its own
      const event = await one<{ payload: Record<string, unknown> }>(
        "select payload from events where org_id = $1 and event_type = 'conversation_logged' and payload ->> 'note_id' = $2",
        [ORG, id],
      );
      expect(Object.keys(event.payload).sort()).toEqual(["channel", "note_id", "note_sha256"]);
    });
  });

  it("the restore pack's 0155 row passes now, and reads a lost CHECK, guard, payload, trigger or function as drift", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const start = "  select 'INTEGRITY: a logged conversation''s outcome is one of three";
    const from = pack.indexOf(start);
    expect(from, "the pack carries the 0155 row").toBeGreaterThan(0);
    const row = `select * from (${pack.slice(from, pack.indexOf("\n  union all\n", from))}) r(check_name, expected, actual)`;
    const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(now.expected).toBe("true true true true");
    expect(now.actual).toBe(now.expected);
    const actual = async () => (await o.query<{ actual: string }>(row)).rows[0]!.actual;
    await rolledBack(async () => {
      await o.query(REVERT_0155_SQL);
      expect(await actual()).toBe("false false false false");
    });
    await rolledBack(async () => {
      await o.query("alter table public.interaction_notes drop constraint interaction_notes_outcome_check");
      await o.query(
        "alter table public.interaction_notes add constraint interaction_notes_outcome_check check (outcome is null or outcome in ('spoke', 'message_sent', 'client_replied')) not valid",
      );
      expect(await actual()).toBe("false true true true");
    });
    await rolledBack(async () => {
      await o.query("alter table public.interaction_notes disable trigger interaction_notes_before");
      expect(await actual()).toBe("true false true true");
    });
    await rolledBack(async () => {
      // 0094's AFTER body back: notes are chained without their outcome
      await o.query(REVERT_0155_SQL.slice(REVERT_0155_SQL.indexOf("create or replace function public.trg_interaction_notes_after_insert()"), REVERT_0155_SQL.indexOf("alter table public.interaction_notes drop constraint")));
      expect(await actual()).toBe("true true false true");
    });
    await rolledBack(async () => {
      await o.query(
        `create function public.log_conversation(p_entity_type text, p_entity_id uuid, p_channel public.comm_channel, p_note text)
         returns uuid language sql as $fn$ select null::uuid $fn$`,
      );
      expect(await actual(), "0094's function beside 0155's").toBe("true true true false");
    });
  });

  it("the test organisation's chain still verifies", async () => {
    const { rows } = await o.query<{ ok: boolean; reason: string | null }>("select ok, reason from public.verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0], rows[0]?.reason ?? "").toMatchObject({ ok: true });
  });
});
