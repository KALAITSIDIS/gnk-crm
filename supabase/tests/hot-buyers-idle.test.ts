import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement } from "react";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * A06 step 7 — the My day card "Hot buyers — no logged contact in 3+ days",
 * through the REAL server component against a REAL PostgREST, as the agent's
 * aal2 session. "Idle" means no LOGGED contact (a logged conversation, a
 * call, a "contacted" stamp) on the buyer, their leads or the deals this
 * agent may read, for three days:
 *
 *   (a) a WhatsApp-link click — on the contact and on their lead, just now —
 *       leaves the buyer idle ("no logged contact yet");
 *   (b) a call logged on the buyer's DEAL just now clears idle;
 *   (c) a profile edit just now leaves the buyer idle;
 *   (d) a conversation logged five days ago: idle, "last logged 5d ago";
 *   (e) a "contacted" stamp on the buyer's LEAD yesterday clears idle;
 *   (f) a call on a colleague's deal this agent cannot read (deals_select)
 *       does not count on THIS agent's card — the strip's contract: ids only
 *       from reads on the viewer's own client;
 *   (g) another organisation's call naming the buyer's id never counts;
 *   and the badge counts every idle buyer, never-logged first; a system read
 *   that does not answer says so instead of listing anyone.
 *
 * Throwaway organisations, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const ORG_X = randomUUID();
const ORGS = [ORG, ORG_X];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>(), brokenSystem: false };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound");
    return c;
  },
}));
// the real service client — or, for one case, one whose every request fails
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  const { createClient } = await import("@supabase/supabase-js");
  return {
    createAdminClient: () =>
      ctx.brokenSystem
        ? createClient(h.SUPABASE_URL, h.SERVICE_ROLE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { fetch: async () => new Response("", { status: 503 }) },
          })
        : h.serviceClient(),
  };
});
// the card's words, from the English catalogue, through next-intl's own ICU
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const en = (await import("@/messages/en.json")).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: "en", messages: en as never, namespace: namespace as never }),
  };
});

import { HotIdleCard } from "@/components/features/dashboard/hot-idle-card";
import { Card, CardEmpty } from "@/components/features/dashboard/card";

// ---------------------------------------------------------------------------
type Element = ReactElement<Record<string, unknown>>;
function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as Element;
  yield el;
  yield* walk(el.props.children);
}
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    const el = node as Element;
    if (el.type === CardEmpty) return String(el.props.text);
    return textOf(el.props.children);
  }
  return "";
}

/** The card as `user` sees it: title, badge, each row's [href, text], and the whole text. */
async function cardOf(user: TestUser) {
  const el = (await ctx.als.run(user.client, () => HotIdleCard({ profileId: user.id }))) as Element;
  expect(el.type).toBe(Card);
  const rows = [...walk(el.props.children)]
    .filter((e) => typeof e.props.href === "string")
    .map((e) => [String(e.props.href), textOf(e.props.children)] as [string, string]);
  return { title: String(el.props.title), count: el.props.count as number | undefined, rows, text: textOf(el.props.children) };
}

let o: Client;
let svc: SupabaseClient;
let agent: TestUser;
let colleague: TestUser;
const userIds: string[] = [];
const buyer: Record<string, string> = {};

async function one(sql: string, args: unknown[] = []): Promise<string> {
  return (await o.query<{ id: string }>(sql, args)).rows[0]!.id;
}
/** an event as the app or a definer writes one — postgres, explicit actor and instant */
const plant = (org: string, actor: string | null, entityType: string, entityId: string, eventType: string, ago: string) =>
  o.query(
    `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload, occurred_at)
     values ($1, $2, $3, $4, $5, '{}'::jsonb, now() - $6::interval)`,
    [org, actor, entityType, entityId, eventType, ago],
  );

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `Hot buyers ${RUN}`, `hot-buyers-${RUN}`);
  await ensureTestOrg(svc, ORG_X, `Hot buyers X ${RUN}`, `hot-buyers-x-${RUN}`);
  agent = await createTestUser(svc, `hb-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
  colleague = await createTestUser(svc, `hb-colleague-${RUN}@test.local`, "agent", ORG, { enrolFactor: false });
  userIds.push(colleague.id);

  const stage = await one(
    "select id from deal_stages where org_id = $1 and deal_type = 'sale' and not is_won and not is_lost order by sort_order limit 1",
    [ORG],
  );
  // one statement each, so created_at — the card's tie-break — is the order here
  for (const k of ["a", "b", "c", "d", "e", "f", "g"]) {
    buyer[k] = await one(
      `insert into contacts (org_id, first_name, last_name, temperature, contact_types, assigned_agent_id)
       values ($1, $2, $3, 'hot', '{buyer}', $4) returning id`,
      [ORG, `HB${TAG}`, k.toUpperCase(), agent.id],
    );
  }
  // a warm buyer with no contact ever is not on a HOT buyers card
  await one(
    `insert into contacts (org_id, first_name, last_name, temperature, contact_types, assigned_agent_id)
     values ($1, $2, 'Warm', 'warm', '{buyer}', $3) returning id`,
    [ORG, `HB${TAG}`, agent.id],
  );
  const lead = (contact: string) =>
    one("insert into leads (org_id, source, contact_id, assigned_agent_id) values ($1, 'phone', $2, $3) returning id", [
      ORG,
      contact,
      agent.id,
    ]);
  const deal = (contact: string, owner: string) =>
    one(
      `insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by, buyer_contact_id)
       values ($1, 'sale', $2, $3, $4, $4, $5) returning id`,
      [ORG, stage, `HB ${TAG} deal`, owner, contact],
    );

  // (a) a chat-link click on the contact and on their lead, just now
  const leadA = await lead(buyer.a);
  await plant(ORG, agent.id, "contact", buyer.a, "chat_link_opened", "1 minute");
  await plant(ORG, agent.id, "lead", leadA, "chat_link_opened", "1 minute");
  // (b) a call logged on the buyer's deal, just now
  await plant(ORG, agent.id, "deal", await deal(buyer.b, agent.id), "called", "1 minute");
  // (c) a profile edit, just now
  await plant(ORG, agent.id, "contact", buyer.c, "updated", "1 minute");
  // (d) a conversation logged five days ago
  await plant(ORG, agent.id, "contact", buyer.d, "conversation_logged", "5 days");
  // (e) a "contacted" stamp on the buyer's lead, yesterday
  await plant(ORG, colleague.id, "lead", await lead(buyer.e), "contacted", "1 day");
  // (f) a colleague's call on the colleague's own deal — not readable by the agent
  await plant(ORG, colleague.id, "deal", await deal(buyer.f, colleague.id), "called", "1 minute");
  // (g) another organisation's call naming this buyer's id
  await plant(ORG_X, null, "contact", buyer.g, "called", "1 minute");
}, 300_000);

afterAll(async () => {
  if (!o) return;
  for (const t of ["tasks", "leads", "deals", "contacts"]) {
    await o.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await o.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await o.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
  await o.end();
}, 120_000);

// ---------------------------------------------------------------------------
describe("Hot buyers — no logged contact in 3+ days", () => {
  it("idle means no LOGGED contact: a chat click and a profile edit leave a buyer idle; a call on the deal and a lead stamp clear it", async () => {
    // the premise of (f): RLS withholds the colleague's deal from this agent
    const { data: visible, error } = await agent.client.from("deals").select("id, buyer_contact_id").eq("buyer_contact_id", buyer.f);
    expect(error).toBeNull();
    expect(visible).toEqual([]);

    const card = await cardOf(agent);
    console.log(`[evidence] hot buyers card: ${card.title} [${card.count}] ${JSON.stringify(card.rows)}`);
    expect(card.title).toBe("Hot buyers — no logged contact in 3+ days");
    const href = (k: string) => `/contacts/${buyer[k]}`;
    // never logged first (in the card's created_at order), then the longest since
    expect(card.rows.map(([h]) => h)).toEqual([href("a"), href("c"), href("f"), href("g"), href("d")]);
    expect(card.count, "the badge counts every idle buyer").toBe(5);
    const row = (k: string) => card.rows.find(([h]) => h === href(k))![1];
    expect(row("a")).toBe(`HB${TAG} A` + "no logged contact yet");
    expect(row("c")).toContain("no logged contact yet");
    expect(row("d")).toContain("last logged 5d ago");
    for (const cleared of ["b", "e"]) expect(card.rows.map(([h]) => h)).not.toContain(href(cleared));
    expect(card.text).not.toContain("Warm");
  });

  it("a system read that does not answer says so — never a list of everyone, never 'all contacted'", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.brokenSystem = true;
    try {
      const card = await cardOf(agent);
      expect(card.count, "no badge: a zero would be a guess").toBeUndefined();
      expect(card.rows).toEqual([]);
      expect(card.text).toBe("Could not check when these buyers were last contacted — reload the page to try again.");
    } finally {
      ctx.brokenSystem = false;
      err.mockRestore();
    }
  });
});
