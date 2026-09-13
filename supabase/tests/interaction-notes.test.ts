/**
 * Notes live in a table; the chain carries their digest (0094, audit SEC-03).
 *
 * `log_conversation(entity_type, entity_id, channel, note)` inserts the note
 * row and the `conversation_logged` event in one transaction, as the caller
 * (SECURITY INVOKER — RLS decides). The event payload carries the channel,
 * the note's id and its SHA-256, never its text, so the chain still proves
 * what was written and erasure can blank the row. Redaction is the service
 * role's business: erasure and the retention sweep.
 *
 * Requires the local Supabase stack. Run: npm run test:rls
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG_A, ORG_B, anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);
let agentA: TestUser;
let agentB: TestUser;
let leadId: string;
let noteId: string;
const NOTE = `Wants a viewing on Saturday, budget around 400k (${run})`;

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  await ensureTestOrg(svc, ORG_B, "Test Org B", "test-org-b");
  agentA = await createTestUser(svc, `notes-a-${run}@example.invalid`, "agent", ORG_A);
  agentB = await createTestUser(svc, `notes-b-${run}@example.invalid`, "agent", ORG_B);
  const { data: lead, error } = await svc
    .from("leads")
    .insert({ org_id: ORG_A, source: "phone", channel: "phone", status: "new", message: `probe ${run}`, assigned_agent_id: agentA.id })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  leadId = lead.id;
});

afterAll(async () => {
  await svc.from("interaction_notes").delete().eq("entity_id", leadId);
  await svc.from("leads").delete().eq("id", leadId);
});

describe("log_conversation", () => {
  it("writes the note row and an event that carries its id and digest, never its text", async () => {
    const { data, error } = await agentA.client.rpc("log_conversation", {
      p_entity_type: "lead",
      p_entity_id: leadId,
      p_channel: "phone",
      p_note: NOTE,
    });
    expect(error).toBeNull();
    noteId = data as string;
    expect(noteId).toMatch(/^[0-9a-f-]{36}$/);

    const { data: note } = await agentA.client.from("interaction_notes").select("body, channel, entity_type, redacted_at, created_by").eq("id", noteId).single();
    expect(note).toMatchObject({ body: NOTE, channel: "phone", entity_type: "lead", redacted_at: null, created_by: agentA.id });

    const { data: events } = await svc
      .from("events")
      .select("payload, actor_id")
      .eq("entity_type", "lead")
      .eq("entity_id", leadId)
      .eq("event_type", "conversation_logged");
    expect(events).toHaveLength(1);
    const payload = events![0]!.payload as Record<string, unknown>;
    expect(payload.note_id).toBe(noteId);
    expect(payload.note_sha256).toBe(createHash("sha256").update(NOTE).digest("hex"));
    expect(payload.channel).toBe("phone");
    expect(payload).not.toHaveProperty("note");
    expect(JSON.stringify(payload)).not.toContain("Saturday");
    expect(events![0]!.actor_id).toBe(agentA.id);
  });

  it("is org-bound: another org's agent sees no such note, and anon is refused", async () => {
    const { data: theirs } = await agentB.client.from("interaction_notes").select("id").eq("id", noteId);
    expect(theirs ?? []).toHaveLength(0);
    const { error } = await anonClient().rpc("log_conversation", { p_entity_type: "lead", p_entity_id: leadId, p_channel: "phone", p_note: "x" });
    expect(error).not.toBeNull();
  });

  it("refuses an empty note and an unknown entity type", async () => {
    const empty = await agentA.client.rpc("log_conversation", { p_entity_type: "lead", p_entity_id: leadId, p_channel: "phone", p_note: "   " });
    expect(empty.error).not.toBeNull();
    const bad = await agentA.client.rpc("log_conversation", { p_entity_type: "property", p_entity_id: leadId, p_channel: "phone", p_note: "x" });
    expect(bad.error).not.toBeNull();
  });

  it("an agent cannot redact a note; the service role can, and the digest in the chain stays", async () => {
    const attempt = await agentA.client.from("interaction_notes").update({ body: null, redacted_at: new Date().toISOString() }).eq("id", noteId).select("id");
    expect(attempt.data ?? [], "no update policy for authenticated").toHaveLength(0);

    const { error } = await svc.from("interaction_notes").update({ body: null, redacted_at: new Date().toISOString() }).eq("id", noteId);
    expect(error).toBeNull();
    const { data: after } = await svc.from("interaction_notes").select("body, redacted_at, body_sha256").eq("id", noteId).single();
    expect(after!.body).toBeNull();
    expect(after!.redacted_at).not.toBeNull();
    expect(after!.body_sha256).toBe(createHash("sha256").update(NOTE).digest("hex"));
  });
});

describe("the retention sweep and notes", () => {
  it("blanks the notes on a website enquiry it redacts", async () => {
    const old = new Date(Date.now() - 25 * 30.5 * 86_400_000).toISOString();
    const { data: lead } = await svc
      .from("leads")
      .insert({ org_id: ORG_A, source: "website", channel: "email", status: "new", message: `Website enquiry\nName: Old ${run}`, received_at: old })
      .select("id")
      .single();
    const { data: nid } = await svc.rpc("log_conversation", { p_entity_type: "lead", p_entity_id: lead!.id, p_channel: "phone", p_note: `called them back ${run}` });
    await svc.rpc("redact_stale_enquiries");
    const { data: note } = await svc.from("interaction_notes").select("body, redacted_at").eq("id", nid as string).single();
    expect(note!.body).toBeNull();
    expect(note!.redacted_at).not.toBeNull();
    await svc.from("interaction_notes").delete().eq("entity_id", lead!.id);
    await svc.from("leads").delete().eq("id", lead!.id);
  });
});
