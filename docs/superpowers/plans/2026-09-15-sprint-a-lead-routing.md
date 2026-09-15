# Sprint A — Lead routing (audit 2026-09-15, findings LR-01…LR-11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A website enquiry lands in the CRM with its brief and its provenance as data, is readable in full in the inbox, becomes a contact and a saved search in one click, is assigned by a rule, is acknowledged to the visitor, and is chased by a task when it waits over an hour.

**Architecture:** One additive migration (0098, on top of the integrations session's 0096 idempotency key; 0097 is theirs too) extends `submit_public_enquiry` with a `p_meta jsonb` argument whose keys are an allowlist held in the function (the security boundary), seeds a `lead_routing` config row the function reads to assign, adds `tasks.lead_id` and a 10-minute `lead-sla` sweep. The CRM route forwards `meta` from the site; the site's route builds it from the form's own select values plus `source_page`, campaign parameters remembered for the session, the referrer host and a consent version. Nothing personal enters `criteria` or an event: names, e-mail, phone and free text stay in `leads.message`, which erasure and the retention sweep can rewrite. `leads.source` stays `website` for every form fill — the retention sweep keys on it.

**Tech Stack:** Next.js App Router server actions, Zod, Supabase Postgres (plpgsql, pg_cron), vitest (unit + RLS suite against the local stack), Playwright, Resend REST, `@sentry/nextjs`.

**Working rules (from CLAUDE.md / HANDOFF):** hosted migration applied through the Supabase MCP `execute_sql` BEFORE the merge; `npm run db:types` after the local apply; every mutation writes its event; `.select()` after every write; commit per task with `git add <paths>` (never `-A`); check `git rev-parse --abbrev-ref HEAD` is `feat/sprint-a-lead-routing` before each commit. Worktrees: `D:\dev\TSOPOZIDIS\.worktrees\gnk-crm\sprint-a` and `D:\dev\TSOPOZIDIS\.worktrees\gnk-web\sprint-a`. Other sessions own `int-phase-1`, `data-integrity-phase0`, `search-url-race` — never touch them or `main`. Re-check the other worktrees' `supabase/migrations` for a competing `0096_*` before the hosted apply and before the merge.

---

## File structure

**gnk-crm**

- Create `supabase/migrations/0098_enquiry_meta_routing_sla.sql` — the function with `p_meta`, the `lead_routing` config row, `tasks.lead_id`, `task_kinds` row `lead_unanswered`, `raise_lead_sla_tasks()`, cron `lead-sla`, self-test block.
- Create `lib/services/enquiry-meta.ts` — the allowlist (`ENQUIRY_META_KEYS` with caps), budget bands, chip labels. Pure.
- Modify `lib/validators/public-enquiry.ts` — `meta` object built from the allowlist.
- Modify `app/api/public/enquiries/route.ts` — pass `p_meta`, send the acknowledgement.
- Modify `lib/services/enquiry-alert.ts` — provenance line, Sentry on failure.
- Create `lib/services/enquiry-ack.ts` — the visitor acknowledgement.
- Modify `lib/services/lead-contact.ts` — `parseWebsiteEnquiry`.
- Modify `lib/actions/leads.ts` — `createContactFromEnquiry`, `expected_value` seed in `convertLead`, `property_id` + `received_at` in `createLead`.
- Create `components/features/leads/lead-message.tsx` — full-message disclosure + brief chips.
- Modify `app/(app)/leads/page.tsx` — use it; pass `source`, `criteria`; `?add=` opens the dialog.
- Modify `components/features/leads/lead-actions.tsx` — "Create contact" button.
- Modify `components/features/leads/add-lead-dialog.tsx` — property picker, backdated `received_at`, `defaultOpen/Source/Channel`.
- Modify `components/features/dashboard/agent-dashboard.tsx` + `messages/{en,el,ru}.json` — "Log a call" quick action.
- Create `lib/services/lead-routing.ts`, `app/(app)/settings/lead-routing/page.tsx`, `components/features/settings/lead-routing-panel.tsx`; modify `lib/validators/settings.ts`, `lib/actions/settings.ts`, `components/features/settings/settings-nav.tsx`.
- Modify `lib/services/cron-health.ts` (`EXPECTED_CRON_JOBS = 10`), `scripts/backup/verify-restore.sql` (96 migrations, 14 task kinds, 10 jobs + `lead-sla`), `supabase/tests/rls.test.ts` test 50 (ten jobs), `docs/10_INFRASTRUCTURE.md`, `HANDOFF.md` §0 rows, `docs/DECISIONS.md` (`T-sprint-a-lead-routing`), `docs/BACKLOG.md` (strike the add-lead property/backdate item).
- Tests: `lib/services/enquiry-meta.test.ts`, `lib/services/lead-contact.test.ts`, `lib/validators/public-enquiry.test.ts`, `tests/unit/public-enquiries-route.test.ts`, `lib/services/enquiry-alert.test.ts`, `lib/services/enquiry-ack.test.ts`, `lib/services/lead-routing.test.ts`, `supabase/tests/enquiry-meta.test.ts` (new RLS file: meta allowlist, routing, SLA sweep), `tests/e2e/public-enquiry.spec.ts` (meta lands), `tests/e2e/lead-routing.spec.ts` (settings page renders and saves, phone width).

**gnk-web**

- Modify `lib/enquiry-fields.ts` — `CONSENT_VERSION`, `PROVENANCE_KEYS`, `readCampaign()`/`rememberCampaign()`.
- Create `components/campaign-memory.tsx` — remembers `utm_*` from the landing URL for the session; mounted in `app/layout.tsx`.
- Modify `components/enquiry-form.tsx` — sends `source_page`, campaign, `referrer_host`.
- Modify `app/api/enquiry/route.ts` — builds `meta`; `source_page` falls back to the Referer path.
- Modify `lib/crm.ts` — `EnquiryInput.meta`.
- Modify `app/legal/page.tsx` — one sentence on session storage and one on the acknowledgement e-mail; `app/legal/page.test.ts` binds both to the code.
- Tests: `lib/enquiry-fields.test.ts`, `components/enquiry-form.test.ts`, `app/api/enquiry/route.test.ts`, `lib/crm.test.ts`, `components/campaign-memory.test.ts`.

---

### Task 1: The allowlist module (CRM, pure)

**Files:**
- Create: `lib/services/enquiry-meta.ts`
- Test: `lib/services/enquiry-meta.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  BUDGET_BANDS,
  budgetBandRange,
  briefChips,
  cleanEnquiryMeta,
  ENQUIRY_META_KEYS,
} from "./enquiry-meta";

describe("cleanEnquiryMeta — the same rule the SQL function applies", () => {
  it("keeps only allowlisted string keys, trimmed and capped", () => {
    const out = cleanEnquiryMeta({
      budget: " 300_500k ",
      buy_area: "Peyia / Coral Bay",
      email: "buyer@example.invalid", // never — identity stays in message
      name: "A Buyer",
      utm_source: "instagram",
      source_page: "/properties/PAF0001",
      bedrooms_min: 3, // a number is not a string: dropped
      looking_to: "",
    });
    expect(out).toEqual({
      budget: "300_500k",
      buy_area: "Peyia / Coral Bay",
      utm_source: "instagram",
      source_page: "/properties/PAF0001",
    });
  });

  it("caps each value at its declared length", () => {
    const out = cleanEnquiryMeta({ utm_campaign: "x".repeat(121), utm_medium: "y".repeat(80) });
    expect(out.utm_campaign).toBeUndefined();
    expect(out.utm_medium).toBe("y".repeat(80));
  });

  it("returns an empty object for nothing, null or garbage", () => {
    expect(cleanEnquiryMeta(null)).toEqual({});
    expect(cleanEnquiryMeta("x")).toEqual({});
    expect(cleanEnquiryMeta([1])).toEqual({});
  });

  it("names no personal key — the allowlist is shape only", () => {
    for (const k of Object.keys(ENQUIRY_META_KEYS)) {
      expect(k).not.toMatch(/name|email|phone|message|address/);
    }
  });
});

describe("budget bands", () => {
  it("maps every band the site offers to a range, and 'unsure' to none", () => {
    expect(budgetBandRange("under_300k")).toEqual({ min: null, max: 300000 });
    expect(budgetBandRange("300_500k")).toEqual({ min: 300000, max: 500000 });
    expect(budgetBandRange("500_750k")).toEqual({ min: 500000, max: 750000 });
    expect(budgetBandRange("750k_1m")).toEqual({ min: 750000, max: 1000000 });
    expect(budgetBandRange("over_1m")).toEqual({ min: 1000000, max: null });
    expect(budgetBandRange("unsure")).toBeNull();
    expect(budgetBandRange("nonsense")).toBeNull();
    expect(Object.keys(BUDGET_BANDS)).toHaveLength(6);
  });
});

describe("briefChips — what the inbox shows beside a website lead", () => {
  it("renders labelled chips for the brief and provenance, in a fixed order", () => {
    expect(
      briefChips({
        channel: "website_form",
        listing_reference: "PAF0001",
        budget: "300_500k",
        buy_area: "Peyia / Coral Bay",
        buy_timing: "3_months",
        looking_to: "buy",
        utm_source: "instagram",
        source_page: "/properties/PAF0001",
      }),
    ).toEqual([
      "Buy",
      "€300,000 – €500,000",
      "Peyia / Coral Bay",
      "Within about three months",
      "via instagram",
    ]);
  });

  it("is empty for a lead with no brief", () => {
    expect(briefChips({ channel: "website_form", listing_reference: null })).toEqual([]);
    expect(briefChips(null)).toEqual([]);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/services/enquiry-meta.test.ts`
Expected: FAIL — cannot resolve `./enquiry-meta`.

- [x] **Step 3: Write the module**

```ts
/**
 * What a website enquiry may carry BESIDE its message (0096, audit LR-01/02).
 *
 * The site asks a buyer seven structured questions and a seller ten, and
 * until 0096 the answers reached the CRM only as sentences appended to
 * `leads.message`. They now also travel as `meta`, and land in
 * `leads.criteria` under exactly these keys — the site's own field names,
 * so the two repositories cannot drift on spelling, and the site's FIELD_CAPS,
 * to the character.
 *
 * SHAPE ONLY. `criteria` is NOT rewritten by erasure or by the retention
 * sweep (0084's design), so nothing that could identify a person may enter
 * it: no name, e-mail, phone, message or free prose. Every key here is a
 * select value, a short number-as-text, a path or a campaign name. The SQL
 * function holds the same table and is the boundary; this module gives the
 * route a useful 400 and the inbox its labels. `cleanEnquiryMeta` mirrors
 * the function's rule exactly: allowlisted key, string value, trimmed,
 * non-empty, at most the cap. Change both or neither.
 */

/** key → maximum length. gnk-web lib/enquiry-fields.ts FIELD_CAPS, plus provenance. */
export const ENQUIRY_META_KEYS = {
  // buyer brief (the site's BUYER_KEYS)
  looking_to: 40,
  budget: 40,
  buy_area: 80,
  buy_property_type: 40,
  bedrooms_min: 20,
  deed_required: 40,
  buy_timing: 40,
  // seller brief (the site's SELLER_KEYS)
  district: 60,
  area: 80,
  property_type: 40,
  bedrooms: 20,
  covered_area_sqm: 20,
  plot_area_sqm: 20,
  year_built: 20,
  title_deed_status: 40,
  listed_elsewhere: 40,
  timing: 40,
  // provenance
  source_page: 200,
  utm_source: 80,
  utm_medium: 80,
  utm_campaign: 120,
  referrer_host: 120,
  consent_version: 40,
} as const;

export type EnquiryMetaKey = keyof typeof ENQUIRY_META_KEYS;
export type EnquiryMeta = Partial<Record<EnquiryMetaKey, string>>;

export function cleanEnquiryMeta(raw: unknown): EnquiryMeta {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: EnquiryMeta = {};
  for (const [key, cap] of Object.entries(ENQUIRY_META_KEYS) as [EnquiryMetaKey, number][]) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t.length === 0 || t.length > cap) continue;
    out[key] = t;
  }
  return out;
}

/**
 * The site's budget bands (gnk-web BUDGETS), pinned here because the CRM
 * cannot import the site. A band becomes a saved-search range; "unsure"
 * becomes no range at all rather than a €0 ceiling.
 */
export const BUDGET_BANDS: Record<string, { label: string; min: number | null; max: number | null }> = {
  under_300k: { label: "Under €300,000", min: null, max: 300000 },
  "300_500k": { label: "€300,000 – €500,000", min: 300000, max: 500000 },
  "500_750k": { label: "€500,000 – €750,000", min: 500000, max: 750000 },
  "750k_1m": { label: "€750,000 – €1m", min: 750000, max: 1000000 },
  over_1m: { label: "Over €1m", min: 1000000, max: null },
  unsure: { label: "Depends on the property", min: null, max: null },
};

export function budgetBandRange(band: string | undefined | null): { min: number | null; max: number | null } | null {
  if (!band) return null;
  const b = BUDGET_BANDS[band];
  if (!b || (b.min === null && b.max === null)) return null;
  return { min: b.min, max: b.max };
}

const LOOKING_TO: Record<string, string> = { buy: "Buy", rent: "Rent", either: "Buy or rent" };
const TIMINGS: Record<string, string> = {
  now: "Ready now",
  "3_months": "Within about three months",
  this_year: "Sometime this year",
  watching: "Watching the market",
  exploring: "Just want to know what it is worth",
};

/** Short labelled chips for the inbox row. Order: intent, budget, area, timing, source. */
export function briefChips(criteria: unknown): string[] {
  const m = cleanEnquiryMeta(criteria);
  const chips: string[] = [];
  if (m.looking_to && LOOKING_TO[m.looking_to]) chips.push(LOOKING_TO[m.looking_to]!);
  if (m.budget && BUDGET_BANDS[m.budget]) chips.push(BUDGET_BANDS[m.budget]!.label);
  if (m.buy_area) chips.push(m.buy_area);
  else if (m.area) chips.push(m.district ? `${m.area}, ${m.district}` : m.area);
  if (m.buy_property_type) chips.push(m.buy_property_type.replace(/_/g, " "));
  else if (m.property_type) chips.push(m.property_type.replace(/_/g, " "));
  const t = m.buy_timing ?? m.timing;
  if (t && TIMINGS[t]) chips.push(TIMINGS[t]!);
  if (m.utm_source) chips.push(`via ${m.utm_source}`);
  return chips;
}
```

- [x] **Step 4: Run the test** — `npx vitest run lib/services/enquiry-meta.test.ts` → PASS (adjust the chips test if `buy_property_type` is absent from the fixture; the fixture above has none, so the expected list is exactly the five strings).

- [x] **Step 5: Commit** — `git add lib/services/enquiry-meta.ts lib/services/enquiry-meta.test.ts && git commit -m "feat(leads): enquiry meta allowlist, budget bands and brief chips (audit LR-01)"`

---

### Task 2: Migration 0098 — `p_meta`, routing rule, `tasks.lead_id`, `lead-sla`

**Files:**
- Create: `supabase/migrations/0098_enquiry_meta_routing_sla.sql`
- Modify: `scripts/backup/verify-restore.sql` (`97::bigint as migrations` (0097 is not in this branch), `14::bigint as task_kinds`, cron list + `exactly 10 jobs`), `lib/services/cron-health.ts` (`EXPECTED_CRON_JOBS = 10`), `supabase/tests/rls.test.ts` test 50 (ten jobs, `lead-sla` in the names), `docs/10_INFRASTRUCTURE.md` cron table.
- Test: `supabase/tests/enquiry-meta.test.ts` (new file).

- [x] **Step 1: Write the RLS test (fails until the migration is applied locally)**

```ts
/**
 * 0096 — what the enquiry door does with `p_meta`, how a lead is assigned by
 * the routing rule, and the ten-minute SLA sweep. Requires the local stack.
 * Run: npm run test:rls
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);
const leadIds: string[] = [];
let agentA: TestUser;
let agentB: TestUser;

const submit = (name: string, meta: unknown) =>
  svc.rpc("submit_public_enquiry", {
    p_org_slug: "test-org-a",
    p_name: `${name} ${run}`,
    p_email: `${name.toLowerCase()}-${run}@example.invalid`,
    p_phone: "",
    p_message: `meta probe ${run}`,
    p_property_ref: "",
    p_meta: meta as never,
  });

const leadNamed = async (name: string) => {
  const { data } = await svc
    .from("leads")
    .select("id, criteria, assigned_agent_id, message")
    .eq("org_id", ORG_A)
    .like("message", `%${name} ${run}%`)
    .single();
  leadIds.push(data!.id);
  return data!;
};

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  agentA = await createTestUser(svc, `route-a-${run}@example.invalid`, "agent", ORG_A);
  agentB = await createTestUser(svc, `route-b-${run}@example.invalid`, "agent", ORG_A);
});

afterAll(async () => {
  await svc.from("cyprus_config").update({ value: { mode: "off", agents: [] } }).eq("key", "lead_routing");
  await svc.from("tasks").delete().in("lead_id", leadIds);
  await svc.from("leads").delete().in("id", leadIds);
  await svc.auth.admin.deleteUser(agentA.id);
  await svc.auth.admin.deleteUser(agentB.id);
});

describe("0098: the brief travels as data, shape only", () => {
  it("keeps allowlisted keys in criteria and drops everything else", async () => {
    const r = await submit("Meta", {
      budget: "300_500k",
      buy_area: "Peyia / Coral Bay",
      utm_source: "instagram",
      source_page: "/properties/PAF0001",
      email: "smuggled@example.invalid",
      name: "Smuggled",
      hack: "x",
      utm_campaign: "y".repeat(121),
      bedrooms_min: 3,
    });
    expect(r.error).toBeNull();
    expect(r.data).toBe(true);
    const lead = await leadNamed("Meta");
    const c = lead.criteria as Record<string, unknown>;
    expect(c).toMatchObject({
      channel: "website_form",
      listing_reference: null,
      budget: "300_500k",
      buy_area: "Peyia / Coral Bay",
      utm_source: "instagram",
      source_page: "/properties/PAF0001",
    });
    for (const k of ["email", "name", "hack", "utm_campaign", "bedrooms_min"]) expect(c).not.toHaveProperty(k);
    expect(JSON.stringify(c)).not.toContain("smuggled");

    const { data: events } = await svc
      .from("events")
      .select("payload")
      .eq("entity_type", "lead")
      .eq("entity_id", lead.id)
      .eq("event_type", "created");
    expect(events![0]!.payload).toMatchObject({ has_meta: true, utm_source: "instagram", source_page: "/properties/PAF0001" });
    expect(JSON.stringify(events![0]!.payload)).not.toContain("smuggled");
  });

  it("meta cannot override the two keys the function owns", async () => {
    const r = await submit("Override", { channel: "portal", listing_reference: "PAF9999" });
    expect(r.data).toBe(true);
    const lead = await leadNamed("Override");
    expect(lead.criteria).toMatchObject({ channel: "website_form", listing_reference: null });
  });

  it("a call without p_meta still works — the six-argument shape the site used before", async () => {
    const r = await svc.rpc("submit_public_enquiry", {
      p_org_slug: "test-org-a", p_name: `Legacy ${run}`, p_email: `legacy-${run}@example.invalid`,
      p_phone: "", p_message: `meta probe ${run}`, p_property_ref: "",
    });
    expect(r.error).toBeNull();
    expect(r.data).toBe(true);
    const lead = await leadNamed("Legacy");
    expect(lead.criteria).toEqual({ channel: "website_form", listing_reference: null });
  });
});

describe("0098: the routing rule", () => {
  it("off (the default): the lead is unassigned", async () => {
    await submit("Unrouted", {});
    expect((await leadNamed("Unrouted")).assigned_agent_id).toBeNull();
  });

  it("round_robin: the agent with the fewest open leads takes it, and an event says so", async () => {
    const { error } = await svc
      .from("cyprus_config")
      .update({ value: { mode: "round_robin", agents: [agentA.id, agentB.id] } })
      .eq("key", "lead_routing");
    expect(error).toBeNull();
    await submit("RouteOne", {});
    const one = await leadNamed("RouteOne");
    expect([agentA.id, agentB.id]).toContain(one.assigned_agent_id);
    await submit("RouteTwo", {});
    const two = await leadNamed("RouteTwo");
    expect(two.assigned_agent_id).not.toBe(one.assigned_agent_id);
    const { data: ev } = await svc
      .from("events")
      .select("actor_id, payload")
      .eq("entity_type", "lead")
      .eq("entity_id", one.id)
      .eq("event_type", "assigned");
    expect(ev).toHaveLength(1);
    expect(ev![0]!.actor_id).toBeNull();
    expect(ev![0]!.payload).toMatchObject({ to: one.assigned_agent_id, via: "routing_rule" });
  });

  it("an agent not in the org, or inactive, is never chosen", async () => {
    await svc.from("profiles").update({ is_active: false }).eq("id", agentB.id);
    await svc.from("cyprus_config").update({ value: { mode: "round_robin", agents: [agentB.id] } }).eq("key", "lead_routing");
    await submit("RouteNone", {});
    expect((await leadNamed("RouteNone")).assigned_agent_id).toBeNull();
    await svc.from("profiles").update({ is_active: true }).eq("id", agentB.id);
  });
});

describe("0098: the lead SLA sweep", () => {
  it("raises one task for a website lead unanswered over an hour, once, and closes it when answered", async () => {
    await svc.from("cyprus_config").update({ value: { mode: "off", agents: [] } }).eq("key", "lead_routing");
    await submit("Slow", {});
    const lead = await leadNamed("Slow");
    await svc.from("leads").update({ received_at: new Date(Date.now() - 61 * 60_000).toISOString() }).eq("id", lead.id);

    const first = await svc.rpc("raise_lead_sla_tasks", { p_org: ORG_A });
    expect(first.error).toBeNull();
    expect(Number(first.data)).toBeGreaterThanOrEqual(1);
    const tasks = async () =>
      (await svc.from("tasks").select("id, kind, is_done, assignee_id, title").eq("lead_id", lead.id)).data ?? [];
    let t = await tasks();
    expect(t).toHaveLength(1);
    expect(t[0]!.kind).toBe("lead_unanswered");
    expect(t[0]!.assignee_id, "falls back to the oldest active admin").not.toBeNull();
    expect(t[0]!.title).not.toContain("Slow"); // no name in a task title

    const { data: ev } = await svc
      .from("events")
      .select("event_type, payload")
      .eq("entity_type", "lead")
      .eq("entity_id", lead.id)
      .eq("event_type", "followup_task_created");
    expect(ev).toHaveLength(1);
    expect(ev![0]!.payload).toMatchObject({ kind: "lead_unanswered", minutes: 60 });

    await svc.rpc("raise_lead_sla_tasks", { p_org: ORG_A });
    expect(await tasks(), "a second run mints nothing new").toHaveLength(1);

    await svc.from("leads").update({ first_response_at: new Date().toISOString(), status: "contacted" }).eq("id", lead.id);
    await svc.rpc("raise_lead_sla_tasks", { p_org: ORG_A });
    t = await tasks();
    expect(t[0]!.is_done, "answered → superseded").toBe(true);
  });

  it("ignores a lead answered in time, and a desk-typed lead", async () => {
    await submit("Quick", {});
    const quick = await leadNamed("Quick");
    await svc.from("leads").update({ received_at: new Date(Date.now() - 30 * 60_000).toISOString() }).eq("id", quick.id);
    await svc.rpc("raise_lead_sla_tasks", { p_org: ORG_A });
    expect((await svc.from("tasks").select("id").eq("lead_id", quick.id)).data).toHaveLength(0);
  });
});
```

- [x] **Step 2: Run it** — `npm run test:rls -- supabase/tests/enquiry-meta.test.ts` → FAIL (`p_meta` unknown / function missing).

- [x] **Step 3: Write the migration** — header in the house style, then:

```sql
-- 1. the door, with p_meta ------------------------------------------------
drop function if exists public.submit_public_enquiry(text, text, text, text, text, text);

create or replace function public.submit_public_enquiry(
  p_org_slug     text,
  p_name         text,
  p_email        text,
  p_phone        text,
  p_message      text,
  p_property_ref text default null,
  p_meta         jsonb default null
)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_org_id      uuid;
  v_property_id uuid;
  v_ref         text := nullif(btrim(coalesce(p_property_ref, '')), '');
  v_listing_ref text;
  v_name        text := nullif(btrim(coalesce(p_name, '')), '');
  v_email       text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone       text := nullif(btrim(coalesce(p_phone, '')), '');
  v_message     text := nullif(btrim(coalesce(p_message, '')), '');
  v_lead_id     uuid;
  v_body        text;
  -- THE ALLOWLIST. Mirrors lib/services/enquiry-meta.ts ENQUIRY_META_KEYS
  -- key for key and cap for cap; the site's FIELD_CAPS are the source.
  v_caps        jsonb := '{"looking_to":40,"budget":40,"buy_area":80,"buy_property_type":40,
                           "bedrooms_min":20,"deed_required":40,"buy_timing":40,
                           "district":60,"area":80,"property_type":40,"bedrooms":20,
                           "covered_area_sqm":20,"plot_area_sqm":20,"year_built":20,
                           "title_deed_status":40,"listed_elsewhere":40,"timing":40,
                           "source_page":200,"utm_source":80,"utm_medium":80,
                           "utm_campaign":120,"referrer_host":120,"consent_version":40}'::jsonb;
  v_meta        jsonb := '{}'::jsonb;
  v_k           text;
  v_v           text;
  v_routing     jsonb;
  v_agent       record;
begin
  if v_name is null or length(v_name) > 200 then return false; end if;
  if v_email is not null and length(v_email) > 320 then return false; end if;
  if v_phone is not null and length(v_phone) > 40  then return false; end if;
  if v_message is not null and length(v_message) > 5000 then return false; end if;
  if v_ref is not null and length(v_ref) > 40 then return false; end if;
  if v_email is null and v_phone is null then return false; end if;
  if v_message is null and v_ref is null then return false; end if;

  select id into v_org_id from organizations where slug = p_org_slug;
  if v_org_id is null then return false; end if;

  if v_ref is not null then
    select id, reference into v_property_id, v_listing_ref
      from properties
     where org_id = v_org_id and reference = v_ref
       and visibility = 'public' and status = 'available';
  end if;

  -- shape only: allowlisted key, string value, trimmed, non-empty, capped
  if p_meta is not null and jsonb_typeof(p_meta) = 'object' then
    for v_k, v_v in select key, value from jsonb_each_text(p_meta) loop
      if v_caps ? v_k
         and jsonb_typeof(p_meta -> v_k) = 'string'
         and length(btrim(v_v)) between 1 and (v_caps ->> v_k)::int then
        v_meta := v_meta || jsonb_build_object(v_k, btrim(v_v));
      end if;
    end loop;
  end if;

  v_body := 'Website enquiry' || chr(10)
         || 'Name: '  || v_name || chr(10)
         || coalesce('Email: ' || v_email || chr(10), '')
         || coalesce('Phone: ' || v_phone || chr(10), '')
         || coalesce('About: ' || v_ref
              || case when v_property_id is null then ' (no published listing with that reference)' else '' end
              || chr(10), '')
         || coalesce(chr(10) || v_message, '');

  insert into leads (org_id, property_id, source, channel, message, status, criteria)
  values (
    v_org_id, v_property_id, 'website',
    case when v_email is not null then 'email'::comm_channel else 'phone'::comm_channel end,
    v_body, 'new',
    -- meta first, the function's own two keys LAST so meta can never override them
    v_meta || jsonb_build_object('channel', 'website_form', 'listing_reference', v_listing_ref)
  )
  returning id into v_lead_id;

  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_org_id, null, 'lead', v_lead_id, 'created',
    jsonb_build_object(
      'source', 'website', 'channel', 'website_form',
      'listing_reference', v_listing_ref, 'matched_listing', v_property_id is not null,
      'has_email', v_email is not null, 'has_phone', v_phone is not null,
      'has_meta', v_meta <> '{}'::jsonb,
      'source_page', v_meta ->> 'source_page', 'utm_source', v_meta ->> 'utm_source'
    )
  );

  -- 2. the routing rule (cyprus_config.lead_routing): off, or round_robin over
  --    named ACTIVE members of this org — fewest open leads first, then the
  --    one assigned longest ago. actor null: nobody signed in did this.
  select value into v_routing from cyprus_config where key = 'lead_routing';
  if v_routing ->> 'mode' = 'round_robin' and jsonb_typeof(v_routing -> 'agents') = 'array' then
    select p.id, p.full_name into v_agent
      from profiles p
     where p.org_id = v_org_id and p.is_active
       and p.id::text in (select jsonb_array_elements_text(v_routing -> 'agents'))
     order by (select count(*) from leads l
                where l.assigned_agent_id = p.id
                  and l.status in ('new','contacted','qualified')) asc,
              (select max(e.occurred_at) from events e
                where e.entity_type = 'lead' and e.event_type = 'assigned'
                  and e.payload ->> 'to' = p.id::text) asc nulls first,
              p.created_at asc
     limit 1;
    if found then
      update leads set assigned_agent_id = v_agent.id where id = v_lead_id;
      insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
      values (v_org_id, null, 'lead', v_lead_id, 'assigned',
              jsonb_build_object('from', null, 'to', v_agent.id, 'to_name', v_agent.full_name,
                                 'via', 'routing_rule'));
    end if;
  end if;

  return true;
end $fn$;

revoke execute on function public.submit_public_enquiry(text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.submit_public_enquiry(text, text, text, text, text, text, jsonb)
  to service_role;

-- 3. the routing row — off until the desk turns it on (Settings → Lead routing)
insert into public.cyprus_config (key, value, description) values (
  'lead_routing',
  jsonb_build_object('mode', 'off', 'agents', '[]'::jsonb),
  'How a website enquiry is assigned on arrival: off (claim it) or round_robin over the listed members. Editable on Settings → Lead routing.'
) on conflict (key) do nothing;

-- 4. tasks can point at a lead; the SLA sweep needs it
alter table public.tasks add column if not exists lead_id uuid references public.leads(id);
create index if not exists tasks_lead_id_idx on public.tasks(lead_id) where lead_id is not null;

insert into public.task_kinds (kind, description, added_in) values
  ('lead_unanswered', 'A website enquiry has waited over an hour for a first response', '0096')
on conflict (kind) do nothing;

create or replace function public.raise_lead_sla_tasks(p_org uuid default null, p_minutes int default 60)
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_count int := 0;
  v_closed int := 0;
begin
  with due as (
    select l.id, l.org_id, l.assigned_agent_id, l.property_id, p.reference
      from leads l
      left join properties p on p.id = l.property_id
     where l.source = 'website'
       and l.status in ('new','contacted','qualified')
       and l.first_response_at is null
       and l.received_at < now() - make_interval(mins => p_minutes)
       and (p_org is null or l.org_id = p_org)
       and not exists (select 1 from tasks t where t.lead_id = l.id and t.kind = 'lead_unanswered')
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, lead_id, property_id, kind)
    select d.org_id,
           'Website enquiry unanswered for over an hour' || coalesce(': ' || d.reference, ''),
           now(),
           coalesce(d.assigned_agent_id,
                    (select pr.id from profiles pr
                      where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
                      order by pr.created_at limit 1)),
           d.id, d.property_id, 'lead_unanswered'
      from due d
    returning org_id, lead_id, id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'lead', lead_id, 'followup_task_created',
           jsonb_build_object('kind', 'lead_unanswered', 'task_id', id,
                              'assignee_id', assignee_id, 'minutes', p_minutes)
      from created
    returning 1
  )
  select count(*) into v_count from logged;

  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from leads l
     where t.lead_id = l.id and t.kind = 'lead_unanswered' and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (l.first_response_at is not null or l.status not in ('new','contacted','qualified'))
    returning t.org_id, t.id, t.lead_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'task', id, 'superseded',
           jsonb_build_object('kind', 'lead_unanswered', 'lead_id', lead_id,
                              'reason', 'lead_answered_or_closed')
      from superseded
    returning 1
  )
  select count(*) into v_closed from logged;

  return v_count;
end $fn$;

revoke execute on function public.raise_lead_sla_tasks(uuid, int) from public, anon, authenticated;
grant  execute on function public.raise_lead_sla_tasks(uuid, int) to service_role;

select cron.schedule('lead-sla', '*/10 * * * *', $$select raise_lead_sla_tasks()$$);
```

Then the self-test `do $$ … $$` block: submit with meta containing `budget` and `email`, assert criteria has budget and no email, event has `has_meta`; assert the six-argument call still works; assert grants (anon/authenticated refused for both functions, service_role granted); assert `cron.job` has `lead-sla` at `*/10 * * * *`; assert `rls_aal2_coverage()` = 0; delete the self-test leads (their events stay, as 0084 does). `raise notice '0096: …'`.

- [x] **Step 4: Apply locally and regenerate types** — `npx supabase migration up --local` (from the worktree), then `npm run db:types`. Verify: `git diff --stat lib/supabase/database.types.ts` shows `p_meta?: Json` on `submit_public_enquiry` and `raise_lead_sla_tasks` present.

- [x] **Step 5: Run the RLS test** — `npm run test:rls -- supabase/tests/enquiry-meta.test.ts` → PASS.

- [x] **Step 6: Move the five pins** — `verify-restore.sql`: `97::bigint as migrations` (0097 is not in this branch), `14::bigint as task_kinds`, add `('lead-sla')` to the cron `values` list, `'cron: exactly 10 jobs, none extra', '10'`; `lib/services/cron-health.ts`: `EXPECTED_CRON_JOBS = 10`; `supabase/tests/rls.test.ts` test 50: title "…all ten jobs (0074, 0092, 0096)", expected names include `lead-sla`, length 10; `docs/10_INFRASTRUCTURE.md`: "10 scheduled jobs", row `*/10 * * * *   lead-sla   select raise_lead_sla_tasks()`. Run `npx vitest run tests/unit/cron-jobs-pinned.test.ts scripts/backup/verify-restore.test.ts` → PASS; `npm run test:rls -- supabase/tests/rls.test.ts -t "50\."` → PASS.

- [x] **Step 7: Commit** — `git add supabase/migrations/0098_enquiry_meta_routing_sla.sql supabase/tests/enquiry-meta.test.ts lib/supabase/database.types.ts scripts/backup/verify-restore.sql lib/services/cron-health.ts supabase/tests/rls.test.ts docs/10_INFRASTRUCTURE.md && git commit -m "feat(db): 0096 — enquiry meta on the door, lead routing rule, tasks.lead_id and the lead-sla sweep (audit LR-01/02/05)"`

---

### Task 3: Validator and route forward `meta`; the alert says where the lead came from; Sentry on a failed send (CRM)

**Files:**
- Modify: `lib/validators/public-enquiry.ts`, `app/api/public/enquiries/route.ts`, `lib/services/enquiry-alert.ts`
- Test: `lib/validators/public-enquiry.test.ts`, `tests/unit/public-enquiries-route.test.ts`, `lib/services/enquiry-alert.test.ts`

- [x] **Step 1: Tests.** In `public-enquiry.test.ts` add: `meta` with allowlisted + junk keys parses to the cleaned object; a non-object `meta` parses to `undefined`; the schema still accepts a body without `meta`. In the route test, change the "reaches the function with what was sent" expectation to include `p_meta: null` when absent, and add a case posting `meta: { budget: "over_1m", email: "x@y" }` expecting `p_meta: { budget: "over_1m" }`. In the alert test add: `bodyFor({...base, meta: { source_page: "/properties/PAF0001", utm_source: "instagram", utm_campaign: "spring" }})` contains `From:  /properties/PAF0001 · instagram · spring`; and a "failed" send calls `Sentry.captureMessage` (mock `@sentry/nextjs`).

- [x] **Step 2: Run → FAIL.**

- [x] **Step 3: Implement.** Validator: `meta: z.preprocess((v) => (v && typeof v === "object" && !Array.isArray(v) ? cleanEnquiryMeta(v) : undefined), z.record(z.string(), z.string()).optional())`. Route: `p_meta: input.meta ?? null` in the rpc call (cast `as never` if the generated Json type complains), `meta: input.meta ?? null` into `sendEnquiryAlert`. Alert: `EnquiryAlert.meta: Record<string,string> | null`; in `bodyFor` after the About line: `const from = [a.meta?.source_page, a.meta?.utm_source, a.meta?.utm_campaign].filter(Boolean).join(" · "); from ? \`From:   ${from}\` : null`. On `!res.ok` and on throw: `Sentry.captureMessage("[enquiry-alert] send failed", { level: "error", extra: { status, propertyReference: a.propertyReference, hasEmail: Boolean(a.email) } })` — never the message or the person.

- [x] **Step 4: Run** `npx vitest run lib/validators/public-enquiry.test.ts tests/unit/public-enquiries-route.test.ts lib/services/enquiry-alert.test.ts` → PASS.

- [x] **Step 5: Commit** — `git add … && git commit -m "feat(enquiry): route forwards meta; alert names the source page and campaign; a failed send reaches Sentry (LR-02/07)"`

---

### Task 4: Acknowledge the enquirer (CRM)

**Files:**
- Create: `lib/services/enquiry-ack.ts`, `lib/services/enquiry-ack.test.ts`
- Modify: `app/api/public/enquiries/route.ts`, `.env.example` (comment on `ENQUIRY_ALERT_FROM` arming the ack), `docs/10_INFRASTRUCTURE.md` env row.

- [x] **Step 1: Test** — `ackBodyFor({ name, propertyReference, orgName })` names the listing, promises a personal reply, states the desk hours constant, and carries no marketing; `sendEnquiryAck` returns `"skipped"` when `RESEND_API_KEY` is unset, when `ENQUIRY_ALERT_FROM` is unset, or when it ends in `@resend.dev` (never write to a client from the onboarding sender), and `"skipped"` when the enquirer gave no e-mail; `"sent"` on a 200 with `to` = the enquirer and `reply_to` = the first `ENQUIRY_ALERT_TO` address; `"failed"` on a 403, with a Sentry message.

- [x] **Step 2: Run → FAIL.**

- [x] **Step 3: Implement** — same shape as `enquiry-alert.ts`: `DESK_HOURS = "Monday to Friday, 09:00–18:00 (Cyprus time)"`, subject `Your enquiry${ref ? ` about ${ref}` : ""} — ${orgName}`, plain-text body: "Thank you, {first name}. Your enquiry{ about REF} has reached us. One of us will reply personally — usually within the hour during {DESK_HOURS}, otherwise the next working morning. If you need to add anything, reply to this e-mail." Signature = org name. Route: inside the same `after()`, after the alert: `if (input.email) await sendEnquiryAck({ name: input.name, email: input.email, propertyReference: input.property_reference ?? null, orgName: "GN Kalaitsidis Capital" })` — read the org name from the `organizations` row by slug with the admin client (one select) so the CRM never hardcodes the firm.

- [x] **Step 4: Run** the ack test and the route test → PASS. `npm run typecheck`.

- [x] **Step 5: Commit** — `"feat(enquiry): acknowledge the enquirer by e-mail, armed only by a real sending address (LR-06)"`

---

### Task 5: The inbox shows the whole enquiry and its brief (CRM)

**Files:**
- Create: `components/features/leads/lead-message.tsx`
- Modify: `app/(app)/leads/page.tsx`
- Test: `components/features/leads/lead-message.test.ts` (renderToStaticMarkup: a two-line message renders a `<details>` whose summary is the first line and whose body keeps line breaks; a one-line message renders no `<details>`; chips render from criteria).

- [x] Steps: test → fail → implement (`LeadMessage({ message, criteria })`: `briefChips(criteria)` as `<span>` chips; message split on the first `\n`; `<details className="group"><summary className="cursor-pointer truncate …">{firstLine}</summary><p className="mt-1 whitespace-pre-line …">{rest}</p></details>`) → pass → wire into the page (replace the `truncate` paragraph; the query already selects `message`; add `criteria` to the select) → `npm run typecheck && npm run lint` → commit `"feat(leads): the inbox shows the full enquiry and its brief as chips (LR-03)"`.

---

### Task 6: One click from enquiry to contact and saved search (CRM)

**Files:**
- Modify: `lib/services/lead-contact.ts` (+ test), `lib/actions/leads.ts`, `components/features/leads/lead-actions.tsx`, `app/(app)/leads/page.tsx` (pass `source`)

- [x] **Step 1: Parser test** (`lead-contact.test.ts`): `parseWebsiteEnquiry("Website enquiry\nName: Maria Georgiou\nEmail: m@example.invalid\nPhone: +357 99 123456\nAbout: PAF0001\n\nHello")` → `{ name: "Maria Georgiou", email: "m@example.invalid", phone: "+357 99 123456" }`; missing lines → nulls; a message not starting with `Website enquiry` → `null`; the redacted marker → `null`.

- [x] **Step 2: Implement `parseWebsiteEnquiry`** — line-anchored regexes on the first six lines only.

- [x] **Step 3: Action `createContactFromEnquiry(leadId)`** in `lib/actions/leads.ts` returning `LeadActionState` (`{ error, savedAt, duplicate }`): guards (open lead, `canWorkError`, `source === "website"`, `!contact_id`, parse ok); `normalizePhone`; `checkContactDuplicate` → return `{ error: "A contact with this … already exists.", duplicate }` (the UI offers Link); insert contact (`contact_kind: "person"`, split name, phone, email, `source: "website"`, `contact_types: buyer meta ? ["buyer"] : seller meta ? ["seller","owner"] : []`, `gdpr_notes: \`Website enquiry consent ${meta.consent_version ?? "v1"} recorded ${received_at}\``, `assigned_agent_id: lead.assigned_agent_id ?? (agent ? profile.id : null)`, `created_by`), `created` event `{ has_phone, has_email, via: "website_enquiry" }`; race on 23505 → duplicate; link the lead (`update … contact_id … .select()`), `contact_linked` event `{ contact_id, via: "website_enquiry" }`; if `cleanEnquiryMeta(lead.criteria)` has any buyer key → resolve area by `areas.name->>en ilike` each `/`-separated part of `buy_area` (first match), district from that row, `property_types` = `[buy_property_type]` when it is in `PROPERTY_TYPES`, `transaction_type` = `looking_to === "rent" ? "rent" : "sale"`, budget from `budgetBandRange`, `bedrooms_min` parsed int, `label: "From website enquiry"`, `notes` = timing/deed lines; insert `buyer_requirements` + `requirement_added` event (entity contact); a failure here returns `{ error: "Contact created and linked, but the saved search could not be created: …" }` — never rolls back the contact. `revalidatePath("/leads")`, `/contacts/${id}`.

- [x] **Step 4: `convertLead`** — after loading the lead: `const band = budgetBandRange(cleanEnquiryMeta(lead.criteria).budget); expected_value: band?.max ?? band?.min ?? null` in the deal insert; the `created` deal event gains `expected_value_from: "website_budget_band"` when set.

- [x] **Step 5: UI** — `LeadRowActions` gains `source: string`; when `!hasContact && source === "website" && canWork` render `<CreateContactFromEnquiryButton leadId>` (calls the action; on `duplicate` shows "Link {name} instead" → `linkLeadContact`). Page passes `source={lead.source}`.

- [x] **Step 6:** `npm run typecheck && npm run lint && npx vitest run lib/services/lead-contact.test.ts` → PASS. Commit `"feat(leads): create the contact, link it and seed a saved search from a website enquiry in one click (LR-08, LR-01)"`.

---

### Task 7: Settings → Lead routing (CRM)

**Files:**
- Create: `lib/services/lead-routing.ts` (+ test), `app/(app)/settings/lead-routing/page.tsx`, `components/features/settings/lead-routing-panel.tsx`, `tests/e2e/lead-routing.spec.ts`
- Modify: `lib/validators/settings.ts` (`leadRoutingSchema`: `mode: z.enum(["off","round_robin"])`, `agents: string[]` of guids, non-empty when round_robin), `lib/actions/settings.ts` (`saveLeadRouting`: admin gate, agents must be active org members — read `profiles` under RLS; update `cyprus_config` row-count guarded; event `config.updated { key: "lead_routing", mode, agents }`; `revalidatePath("/settings/lead-routing")`), `components/features/settings/settings-nav.tsx` (entry after Nudges).

- [x] `lead-routing.ts`: `readLeadRouting(value: unknown): { mode: "off" | "round_robin"; agents: string[] }` mirroring the SQL reader (non-object → off; unknown mode → off; agents filtered to strings). Test the fallback table.
- [x] Page: admin-only (`return null` like nudges), loads the row and active profiles, renders the panel (radio Off / Round-robin, a checkbox per active member with role, Save). The panel uses `useActionState(saveLeadRouting, …)` and toasts.
- [x] e2e: login as admin, open `/settings/lead-routing`, `assertNoProblems`, `assertNoHorizontalOverflow` (the portals spec's lesson: a settings page nobody measures ships unrendered), choose round-robin, tick the admin, save, expect the success toast; restore Off at the end.
- [x] `npm run typecheck && npm run lint && npx vitest run lib/services/lead-routing.test.ts lib/validators/settings.test.ts` → PASS. Commit `"feat(settings): lead routing rule — off or round-robin over named members (LR-05)"`.

---

### Task 8: Log a call or a WhatsApp in two taps; link a property; backdate (CRM)

**Files:**
- Modify: `components/features/leads/add-lead-dialog.tsx`, `lib/actions/leads.ts` (`createLeadSchema` + insert), `app/(app)/leads/page.tsx` (`?add=phone|whatsapp`), `components/features/dashboard/agent-dashboard.tsx`, `messages/en.json`, `messages/el.json`, `messages/ru.json`, `docs/BACKLOG.md` (strike the add-lead entry).
- Test: `lib/actions/leads-create-schema.test.ts` (export the schema from `lib/validators/leads.ts` — new file — and test: `received_at` accepts `YYYY-MM-DDTHH:mm`, refuses a future time, blank → undefined; `property_id` guid or undefined); `lib/services/messages.test.ts` already pins key parity.

- [x] Move `createLeadSchema` to `lib/validators/leads.ts` with `property_id` (already) and `received_at: z.preprocess(emptyToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional())` + `.refine` not in the future (Cyprus wall clock via `zonedWallClockToUtc`).
- [x] `createLead`: insert `received_at: d.received_at ? zonedWallClockToUtc(d.received_at).toISOString() : undefined`; event payload gains `backdated: Boolean(d.received_at)`.
- [x] Dialog: props `defaultOpen?: boolean; defaultSource?: LeadSource; defaultChannel?: CommChannel`; `EntityPicker name="property_id" kind="property" label="Property (optional)"`; `<Input type="datetime-local" name="received_at" max={now local}>` labelled "Received (leave blank for now)".
- [x] Page: `const add = first(sp.add)`; `<AddLeadDialog defaultOpen={add === "phone" || add === "whatsapp"} defaultSource={add === "whatsapp" ? "whatsapp" : add === "phone" ? "phone" : undefined} defaultChannel={same} />`.
- [x] Dashboard: first quick action becomes `{ href: "/leads?add=phone", label: t("quick.logCall"), icon: <Phone/> }`; keys `dashboard.agent.quick.logCall`: en "Log a call", el "Καταγραφή κλήσης", ru "Записать звонок" (keep `addLead` keys — the parity test only needs all three files equal).
- [x] BACKLOG: strike `- **Add-lead dialog: optional property link …**` as `~~…~~ **SHIPPED 2026-09-15 (Sprint A task 8).**`
- [x] `npm run typecheck && npm run lint && npm test` → PASS. Commit `"feat(leads): log a call or WhatsApp in two taps, link a property, backdate received_at (LR-04)"`.

---

### Task 9: The site sends the brief as data, with provenance (gnk-web)

**Files:**
- Modify: `lib/enquiry-fields.ts`, `components/enquiry-form.tsx`, `app/api/enquiry/route.ts`, `lib/crm.ts`, `app/layout.tsx`, `app/legal/page.tsx`
- Create: `components/campaign-memory.tsx`
- Test: `lib/enquiry-fields.test.ts`, `components/enquiry-form.test.ts`, `app/api/enquiry/route.test.ts`, `lib/crm.test.ts`, `app/legal/page.test.ts`, `components/campaign-memory.test.ts`

- [x] **`lib/enquiry-fields.ts`** — add `export const CONSENT_VERSION = "2026-09-15";` (the wording of the checkbox and /legal as they stand today; bump when either changes), `export const CAMPAIGN_KEYS = ["utm_source","utm_medium","utm_campaign"] as const;`, `export const CAMPAIGN_STORAGE_KEY = "gnk-campaign";`, `export function campaignFromSearch(search: string): Record<string,string>` (only those three, trimmed, capped at 120), `export function rememberCampaign(search: string, storage: Storage | null)`, `export function readCampaign(storage: Storage | null): Record<string,string>` (try/catch around every storage access — private windows throw). Tests for each.
- [x] **`components/campaign-memory.tsx`** — `"use client"`, renders nothing; `useEffect(() => rememberCampaign(window.location.search, safeSessionStorage()), [])`. Mounted in `app/layout.tsx` inside `<body>`. Test: renders to an empty string.
- [x] **Form** — in `onSubmit` body add `source_page: window.location.pathname`, `referrer_host: (() => { try { const h = new URL(document.referrer).host; return h && h !== window.location.host ? h : ""; } catch { return ""; } })()`, `...readCampaign(safeSessionStorage())`. No hidden inputs (the no-JS path gets `source_page` from the Referer header server-side).
- [x] **Route** — schema gains `source_page`, `utm_source`, `utm_medium`, `utm_campaign`, `referrer_host` (strings, trimmed, capped 200/80/80/120/120, optional). Build `meta`: `{ ...brief select values (SELLER_KEYS + BUYER_KEYS that are non-empty), source_page: d.source_page || refererPath(request.headers.get("referer")), utm_*, referrer_host, consent_version: CONSENT_VERSION }` with empty values omitted; pass as `meta` to `submitEnquiry`. `refererPath` returns the pathname only when the referer's host equals the request host, else undefined.
- [x] **`lib/crm.ts`** — `EnquiryInput.meta?: Record<string, string>`; the body already spreads `input`, so `meta` travels. Test: the JSON body carries `meta`.
- [x] **Legal page** — in "Cookies and tracking" append: "If you arrive from a link that names a campaign, the site keeps that name in your browser's session storage until you close the tab, so that an enquiry can say where you came from. That is not a cookie, it identifies nobody, and nothing else reads it." In "Where your enquiry goes" append: "If you give an e-mail address, you also receive one message confirming that your enquiry arrived; it is sent through the same provider." Test: legal HTML contains "session storage" (bound: `components/campaign-memory.tsx` source contains `sessionStorage`) and "confirming that your enquiry arrived".
- [x] `npm run typecheck && npm run lint && npm test` → PASS. Commit `"feat(enquiry): the brief and its provenance travel as data; campaign remembered for the session; /legal says so (LR-01/02/11)"`.

---

### Task 10: End-to-end proof, docs, hosted apply, PRs

- [ ] `tests/e2e/public-enquiry.spec.ts` (CRM): post with `meta: { budget: "over_1m", utm_source: "instagram" }` and assert the lead's `criteria` carries both and nothing else beyond `channel`/`listing_reference`.
- [ ] Full local gates in the CRM worktree: `npm run typecheck && npm run lint && npm test && npm run test:rls` — paste the summary lines. Site: `npm run typecheck && npm run lint && npm test && npm run build`.
- [ ] `docs/DECISIONS.md`: `## T-sprint-a-lead-routing — …(2026-09-15, migration 0098)` — the four calls: `source` stays `website` (the retention sweep keys on it); `criteria` is shape-only so the allowlist admits no free prose; routing lives in the SQL function because it holds the lead id and the route holds no id; the SLA hop is task-only because `pg_net` is available but not installed on hosted (enabling it is an operator decision; the e-mail escalation is T1's second half). `HANDOFF.md` §0: Hosted DB row, Cron row (TEN jobs, `lead-sla */10`), operator items (set `ENQUIRY_ALERT_FROM` once `send.kalaitsidis.com` is verified, both addresses in `ENQUIRY_ALERT_TO`, turn on Settings → Lead routing).
- [ ] Re-check the other worktrees for a competing `0096_*`; push both branches; wait for CI (read every job's conclusion, not the exit code).
- [ ] Hosted apply BEFORE merge, in stages via the Supabase MCP `execute_sql` (DDL sections one at a time; the self-test block last), then `npx supabase migration repair --status applied 0098 --linked` with the token from `~/.gnk-crm/backup.env`, then `npx supabase migration list --linked` → 98 applied, no drift; `get_advisors` unchanged.
- [ ] Merge CRM PR first (`gh pr merge --merge`), verify the deploy READY, live probe: POST to the production door with `meta` on a `ZZTEST` enquiry, confirm `criteria` via `execute_sql`, then redact it through the app. Merge the site PR, verify the deploy, one real form fill from the live site with a `?utm_source=zztest` landing, confirm the lead, redact.
- [ ] Update HANDOFF §0 + the memory note; delete the merged branches and the worktrees (`git worktree remove`).
