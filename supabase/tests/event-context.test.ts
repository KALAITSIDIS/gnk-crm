/**
 * What a timeline may call a task or a document, measured against the real
 * policies. Requires the local Supabase stack.
 *
 * Since T-event-typed-text-shape a task's `completed` / `reopened` event and a
 * document's `document_uploaded` event carry ids, never the title (SEC-03).
 * `lib/services/event-context.ts` reads the CURRENT title back from the row on
 * the viewer's own client, so that RLS — not the reader — decides:
 *
 * - `tasks_select`: an admin, or the task's assignee or creator (0032);
 * - `documents_select`: an admin, or a document whose visibility is 'internal'
 *   (0002), which is what keeps an admin_only passport scan's name off an
 *   agent's timeline;
 * - both: the viewer's own org only.
 *
 * The unit test (lib/services/event-context.test.ts) pins the transport; this
 * file proves the permission, with the service client as the control that each
 * row really exists — a title an agent does not get must be RLS's doing, not a
 * missing fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { attachCurrentTitles } from "@/lib/services/event-context";
import { ORG_A, ORG_B, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);

let admin: TestUser;
let agent: TestUser;
let colleague: TestUser;
let outsider: TestUser;

const ids = {
  taskMine: "",
  taskColleague: "",
  taskOtherOrg: "",
  docInternal: "",
  docAdminOnly: "",
  docOtherOrg: "",
};
// synthetic titles, each distinct so a leak names its source
const TITLE = {
  taskMine: `ZZCTX ${run} call the notary`,
  taskColleague: `ZZCTX ${run} Kyriakoula Palaiopoulou deposit`,
  taskOtherOrg: `ZZCTX ${run} other org task`,
  docInternal: `ZZCTX ${run} Sale agreement.pdf`,
  docAdminOnly: `ZZCTX ${run} passport_AB1234567.pdf`,
  docOtherOrg: `ZZCTX ${run} other org deed.pdf`,
};

async function task(org: string, title: string, assignee: string): Promise<string> {
  const { data, error } = await svc
    .from("tasks")
    .insert({ org_id: org, title, assignee_id: assignee, created_by: assignee })
    .select("id")
    .single();
  if (error) throw new Error(`seed task: ${error.message}`);
  return data.id as string;
}

async function doc(org: string, title: string, docType: string, visibility: string, by: string): Promise<string> {
  const { data, error } = await svc
    .from("documents")
    .insert({
      org_id: org,
      entity_type: "contact",
      entity_id: crypto.randomUUID(),
      doc_type: docType,
      title,
      storage_path: `${org}/contacts/zzctx-${run}/${crypto.randomUUID()}.pdf`,
      visibility,
      uploaded_by: by,
    })
    .select("id")
    .single();
  if (error) throw new Error(`seed document: ${error.message}`);
  return data.id as string;
}

/** the event shapes the fixed writers produce — ids only, no titles */
const events = () => [
  { entity_type: "task", entity_id: ids.taskMine, event_type: "completed", payload: {} },
  { entity_type: "task", entity_id: ids.taskColleague, event_type: "completed", payload: {} },
  { entity_type: "task", entity_id: ids.taskOtherOrg, event_type: "reopened", payload: {} },
  docEvent(ids.docInternal, "contract", "internal"),
  docEvent(ids.docAdminOnly, "id_document", "admin_only"),
  docEvent(ids.docOtherOrg, "contract", "internal"),
];
const docEvent = (id: string, doc_type: string, visibility: string) => ({
  entity_type: "contact",
  entity_id: crypto.randomUUID(),
  event_type: "document_uploaded",
  payload: { document_id: id, doc_type, visibility },
});

async function titlesSeenBy(client: SupabaseClient, org: string) {
  const out = await attachCurrentTitles(client as never, org, events());
  const [taskMine, taskColleague, taskOtherOrg, docInternal, docAdminOnly, docOtherOrg] = out.map(
    (e) => e.current_title ?? null,
  );
  return { taskMine, taskColleague, taskOtherOrg, docInternal, docAdminOnly, docOtherOrg };
}

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  await ensureTestOrg(svc, ORG_B, "Test Org B", "test-org-b");
  admin = await createTestUser(svc, `ctx-admin-${run}@test.local`, "admin", ORG_A);
  agent = await createTestUser(svc, `ctx-agent-${run}@test.local`, "agent", ORG_A);
  colleague = await createTestUser(svc, `ctx-colleague-${run}@test.local`, "agent", ORG_A);
  outsider = await createTestUser(svc, `ctx-outsider-${run}@test.local`, "admin", ORG_B);

  ids.taskMine = await task(ORG_A, TITLE.taskMine, agent.id);
  ids.taskColleague = await task(ORG_A, TITLE.taskColleague, colleague.id);
  ids.taskOtherOrg = await task(ORG_B, TITLE.taskOtherOrg, outsider.id);
  ids.docInternal = await doc(ORG_A, TITLE.docInternal, "contract", "internal", admin.id);
  // a KYC contact row must be admin_only (the 0072 CHECK)
  ids.docAdminOnly = await doc(ORG_A, TITLE.docAdminOnly, "id_document", "admin_only", admin.id);
  ids.docOtherOrg = await doc(ORG_B, TITLE.docOtherOrg, "contract", "internal", outsider.id);
});

afterAll(async () => {
  await svc.from("tasks").delete().in("id", [ids.taskMine, ids.taskColleague, ids.taskOtherOrg].filter(Boolean));
  await svc
    .from("documents")
    .delete()
    .in("id", [ids.docInternal, ids.docAdminOnly, ids.docOtherOrg].filter(Boolean));
});

describe("a timeline's current titles are what the VIEWER may read", () => {
  it("control: every fixture row exists (the service client reads them all)", async () => {
    const { data: tasks } = await svc.from("tasks").select("id, title").in("id", [ids.taskMine, ids.taskColleague, ids.taskOtherOrg]);
    const { data: docs } = await svc
      .from("documents")
      .select("id, title")
      .in("id", [ids.docInternal, ids.docAdminOnly, ids.docOtherOrg]);
    expect(tasks).toHaveLength(3);
    expect(docs).toHaveLength(3);
  });

  it("an agent gets their own task and the internal document — not a colleague's task, not the passport scan", async () => {
    expect(await titlesSeenBy(agent.client, ORG_A)).toEqual({
      taskMine: TITLE.taskMine,
      taskColleague: null,
      taskOtherOrg: null,
      docInternal: TITLE.docInternal,
      docAdminOnly: null,
      docOtherOrg: null,
    });
  });

  it("an admin gets every row of their own org, the admin_only document included — and nothing of another org", async () => {
    expect(await titlesSeenBy(admin.client, ORG_A)).toEqual({
      taskMine: TITLE.taskMine,
      taskColleague: TITLE.taskColleague,
      taskOtherOrg: null,
      docInternal: TITLE.docInternal,
      docAdminOnly: TITLE.docAdminOnly,
      docOtherOrg: null,
    });
  });

  it("naming ANOTHER org buys nothing: RLS still answers for the viewer's own", async () => {
    // the explicit org filter and current_org_id() must BOTH hold, so a caller
    // that passed the wrong org gets no titles rather than the other org's
    const seen = await titlesSeenBy(agent.client, ORG_B);
    expect(Object.values(seen).every((v) => v === null)).toBe(true);
    const seenByAdmin = await titlesSeenBy(admin.client, ORG_B);
    expect(Object.values(seenByAdmin).every((v) => v === null)).toBe(true);
  });

  it("the other org's admin sees only the other org's rows", async () => {
    expect(await titlesSeenBy(outsider.client, ORG_B)).toEqual({
      taskMine: null,
      taskColleague: null,
      taskOtherOrg: TITLE.taskOtherOrg,
      docInternal: null,
      docAdminOnly: null,
      docOtherOrg: TITLE.docOtherOrg,
    });
  });

  it("a deleted row reads as nothing, for everyone", async () => {
    const gone = await task(ORG_A, `ZZCTX ${run} deleted`, agent.id);
    await svc.from("tasks").delete().eq("id", gone);
    const [e] = await attachCurrentTitles(admin.client as never, ORG_A, [
      { entity_type: "task", entity_id: gone, event_type: "completed", payload: {} },
    ]);
    expect(e.current_title).toBeUndefined();
  });
});
