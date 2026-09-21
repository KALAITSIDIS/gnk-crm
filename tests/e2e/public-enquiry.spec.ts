import { randomBytes } from "node:crypto";
import { test, expect, request as pwRequest } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { baseUrl, fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The public enquiry door, over real HTTP (WF-4, migration 0084).
 *
 * The RLS suite pins what the anon ROLE can reach; this pins what the ROUTE
 * does with it — the status codes a site developer builds against, the
 * honeypot, and that a submission really becomes a lead the desk can work.
 *
 * Deliberately unauthenticated: it uses a bare request context with no storage
 * state, because a visitor filling in a form on a marketing site has no
 * session. If this ever starts needing one, that is the bug.
 */
const svc = (): SupabaseClient => serviceClient();

test.beforeEach(({}, testInfo) => {
  test.skip(!isLocal(), "needs the local stack service key");
  // API-only: no viewport is involved, and running it twice was running it
  // twice against one budget (see apiContext). CI runs desktop alone; locally,
  // so does this.
  test.skip(testInfo.project.name === "mobile", "API-only spec — one project is enough");
});

const ORG_SLUG = "gnk";

/**
 * EVERY TEST GETS ITS OWN VISITOR ADDRESS, AND THEREFORE ITS OWN BUDGET.
 *
 * The door meters five posts per quarter hour per address (RATE_LIMIT,
 * lib/services/enquiry-budget.ts) against 15-minute ALIGNED buckets, and this
 * file used to send every request from one of them. Six posts across five
 * tests already sat on the edge of that: measured 2026-09-15, desktop's seven
 * passed and mobile's three failed on exactly this; measured again 2026-09-20,
 * running the file TWICE inside one bucket turned three passing tests red with
 * a 429 they were never about. A shared, time-aligned, run-to-run counter is
 * not something a test should depend on having spare capacity in.
 *
 * `callerIpHash` reads `x-forwarded-for` first (lib/services/caller-ip.ts) —
 * which is how a real visitor arrives behind Vercel — so a distinct address per
 * request context is a distinct counter. Note this is NOT `x-gnk-visitor-ip`:
 * that one is believed only from a caller holding ENQUIRY_FORWARD_KEY
 * (lib/services/forwarder.ts), which is deliberately unset here, so it would be
 * ignored and every context would share the budget again.
 *
 * THE RUN TOKEN IS THE OTHER HALF. A per-test counter that is the SAME per test
 * on every run just moves the collision: the rate-limit test below spends an
 * address's whole budget, so a second run inside the same quarter hour would
 * open on a 429. The address carries a random token per run, and the buckets
 * are 15 minutes wide, so no two runs can meet.
 *
 * 2001:db8::/32 is RFC 3849's documentation prefix — reserved, routable
 * nowhere, and large enough that the token need not be coordinated. hashIp
 * takes the header as a string and never parses it (lib/services/ip-hash.ts),
 * so the family makes no difference to the counter.
 */
const runToken = randomBytes(4).toString("hex");
let nextVisitor = 11;
const apiContext = () =>
  pwRequest.newContext({
    baseURL: baseUrl(),
    extraHTTPHeaders: { "x-forwarded-for": `2001:db8:${runToken}::${nextVisitor++}` },
  });

test("a website enquiry becomes a lead the desk can work", async () => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const marker = `e2e-enq-${randomBytes(3).toString("hex")}`;
  const api = await apiContext();

  try {
    const res = await api.post("/api/public/enquiries", {
      data: {
        org: ORG_SLUG,
        name: `Web Buyer ${marker}`,
        email: `${marker}@example.invalid`,
        message: `Is this still available? ${marker}`,
      },
    });
    expect(res.status(), "202: the desk decides what it becomes").toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    // no id comes back — there is nothing a caller could legitimately do with one
    expect(JSON.stringify(await res.json())).not.toContain("id");

    const { data: leads } = await admin
      .from("leads")
      .select("id, source, status, contact_id, message")
      .eq("org_id", orgId)
      .like("message", `%${marker}%`);
    expect(leads ?? []).toHaveLength(1);
    expect(leads![0]!.source).toBe("website");
    expect(leads![0]!.status).toBe("new");
    expect(leads![0]!.contact_id, "anonymous traffic mints no contacts").toBeNull();
    expect(leads![0]!.message, "the desk can see how to reply").toContain(
      `${marker}@example.invalid`,
    );

    await admin.from("leads").delete().eq("id", leads![0]!.id);
  } finally {
    await api.dispose();
  }
});

test("the door refuses what it cannot act on, and says why", async () => {
  const api = await apiContext();
  try {
    const noReply = await api.post("/api/public/enquiries", {
      data: { org: ORG_SLUG, name: "Nobody", message: "hello" },
    });
    expect(noReply.status()).toBe(400);
    expect((await noReply.json()).error).toMatch(/email address or a phone number/i);

    const noSubject = await api.post("/api/public/enquiries", {
      data: { org: ORG_SLUG, name: "Nobody", email: "a@example.invalid" },
    });
    expect(noSubject.status()).toBe(400);
    expect((await noSubject.json()).error).toMatch(/message or a `property_reference`/i);

    const badOrg = await api.post("/api/public/enquiries", {
      data: {
        org: `no-such-org-${randomBytes(2).toString("hex")}`,
        name: "Nobody",
        email: "a@example.invalid",
        message: "hi",
      },
    });
    expect(badOrg.status(), "an unknown agency is the caller's mistake").toBe(400);

    const notJson = await api.post("/api/public/enquiries", {
      headers: { "Content-Type": "text/plain" },
      data: "name=x",
    });
    expect(notJson.status()).toBe(415);
  } finally {
    await api.dispose();
  }
});

test("a filled honeypot is dropped, and told nothing", async () => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const marker = `e2e-bot-${randomBytes(3).toString("hex")}`;
  const api = await apiContext();

  try {
    const res = await api.post("/api/public/enquiries", {
      data: {
        org: ORG_SLUG,
        name: `Bot ${marker}`,
        email: `${marker}@example.invalid`,
        message: `spam ${marker}`,
        website: "http://spam.example",
      },
    });
    // the same answer a real submission gets: a bot that learns which shape is
    // rejected simply changes shape
    expect(res.status()).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });

    const { data: leads } = await admin
      .from("leads")
      .select("id")
      .eq("org_id", orgId)
      .like("message", `%${marker}%`);
    expect(leads ?? [], "nothing reached the desk").toHaveLength(0);
  } finally {
    await api.dispose();
  }
});

test("the brief and its provenance land in criteria as data, shape only (0098)", async () => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const marker = `e2e-meta-${randomBytes(3).toString("hex")}`;
  const api = await apiContext();

  try {
    const res = await api.post("/api/public/enquiries", {
      data: {
        org: ORG_SLUG,
        name: `Web Buyer ${marker}`,
        email: `${marker}@example.invalid`,
        message: `Budget block probe ${marker}`,
        meta: {
          budget: "over_1m",
          buy_area: "Peyia / Coral Bay",
          utm_source: "instagram",
          source_page: "/properties/PAF0001",
          email: "smuggled@example.invalid", // identity has no key in the allowlist
          hack: "x",
        },
      },
    });
    expect(res.status()).toBe(202);

    const { data: leads } = await admin
      .from("leads")
      .select("id, criteria")
      .eq("org_id", orgId)
      .like("message", `%${marker}%`);
    expect(leads ?? []).toHaveLength(1);
    const criteria = leads![0]!.criteria as Record<string, unknown>;
    expect(criteria).toEqual({
      channel: "website_form",
      listing_reference: null,
      budget: "over_1m",
      buy_area: "Peyia / Coral Bay",
      utm_source: "instagram",
      source_page: "/properties/PAF0001",
    });
    expect(JSON.stringify(criteria)).not.toContain("smuggled");

    await admin.from("tasks").delete().eq("lead_id", leads![0]!.id);
    await admin.from("leads").delete().eq("id", leads![0]!.id);
  } finally {
    await api.dispose();
  }
});

test("CORS is open for a site on another origin, POST only", async () => {
  const api = await apiContext();
  try {
    const res = await api.fetch("/api/public/enquiries", { method: "OPTIONS" });
    expect(res.status()).toBe(204);
    const allow = res.headers();
    expect(allow["access-control-allow-origin"]).toBe("*");
    expect(allow["access-control-allow-methods"]).toContain("POST");
    // there is no read surface here to open by accident
    expect(allow["access-control-allow-methods"]).not.toContain("GET");
  } finally {
    await api.dispose();
  }
});

/* ---------------------------------------------------------------------------
 * The release-compatibility acceptance criteria, over the REAL route.
 *
 * supabase/tests/release-compat.test.ts asks whether each deployed CRM's call
 * still agrees with the database. These three ask the other half — whether the
 * ROUTE, which is where the desk alert and the counter live, still behaves as
 * promised end to end. tests/unit/public-enquiries-route.test.ts pins the same
 * three against a MOCKED admin client, which can pin the route's reading of a
 * shape it is told about and can never notice the database disagreeing.
 *
 * EACH ONE BRINGS ITS OWN ADDRESS. The door's budget is five posts per quarter
 * hour per address, and the tests above already spend most of one bucket
 * between them — the file's own beforeEach says so. `x-forwarded-for` is what
 * callerIpHash reads (lib/services/caller-ip.ts), so a distinct TEST-NET-3
 * address per test is a distinct counter, and these neither spend the shared
 * budget nor depend on what is left of it. That also makes the 429 test
 * possible at all.
 * ------------------------------------------------------------------------ */

/** RFC 5737 TEST-NET-3 — documentation addresses, routable nowhere. */

/** `after()` runs once the 202 is out, so the alert's event lands afterwards. */
async function waitForEvents(
  admin: SupabaseClient,
  leadId: string,
  eventType: string,
): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 40; i++) {
    const { data } = await admin
      .from("events")
      .select("event_type, payload")
      .eq("entity_id", leadId)
      .eq("event_type", eventType);
    if ((data ?? []).length > 0) return data as Array<Record<string, unknown>>;
    await new Promise((r) => setTimeout(r, 250));
  }
  return [];
}

async function removeLeads(admin: SupabaseClient, ids: string[]): Promise<void> {
  if (!ids.length) return;
  // tasks first: the 0098 SLA sweep attaches them, and a refused delete would
  // leave residue behind a green test (RLS test 38's lesson)
  const tasks = await admin.from("tasks").delete().in("lead_id", ids);
  if (tasks.error) throw new Error(`cleanup tasks: ${tasks.error.message}`);
  const leads = await admin.from("leads").delete().in("id", ids);
  if (leads.error) throw new Error(`cleanup leads: ${leads.error.message}`);
}

test("a repeat with the same key is the same enquiry: one lead, and the desk told once", async () => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const marker = `e2e-replay-${randomBytes(3).toString("hex")}`;
  const api = await apiContext();
  const key = `replay-${marker}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64);
  let leadId: string | null = null;

  try {
    const send = () =>
      api.post("/api/public/enquiries", {
        data: {
          org: ORG_SLUG,
          name: `Web Buyer ${marker}`,
          email: `${marker}@example.invalid`,
          message: `Is this still available? ${marker}`,
          idempotency_key: key,
        },
      });

    const first = await send();
    const again = await send();
    expect(first.status(), "the first post is accepted").toBe(202);
    expect(again.status(), "and so is the repeat — a visitor is not punished for retrying").toBe(
      202,
    );

    const { data: leads } = await admin
      .from("leads")
      .select("id, idempotency_key")
      .eq("org_id", orgId)
      .like("message", `%${marker}%`);
    expect(leads ?? [], "one lead for one key").toHaveLength(1);
    leadId = leads![0]!.id as string;
    expect(leads![0]!.idempotency_key).toBe(key);

    const created = await waitForEvents(admin, leadId, "created");
    expect(created, "one created event — the repeat wrote nothing").toHaveLength(1);

    /* AND THE DESK IS TOLD ONCE. Since 0101 the desk alert is a
       `notification_jobs` row the function writes WITH the lead, and a replay
       writes nothing — so the durable proof of "one notification for two
       posts" is one row, whatever the provider did with it. The route also
       returns before `after()` on a replay (route.ts: `if (row.replayed)
       return`), so the accelerator runs once at most. */
    const { data: jobs, error: jobsErr } = await admin
      .from("notification_jobs")
      .select("kind, state, attempts")
      .eq("lead_id", leadId);
    expect(jobsErr).toBeNull();
    expect(jobs ?? [], "one desk-alert record for two posts").toHaveLength(1);
    expect(jobs![0]!.kind).toBe("enquiry_desk_alert");
    expect(jobs![0]!.attempts, "at most one attempt for two posts").toBeLessThanOrEqual(1);
  } finally {
    await removeLeads(admin, leadId ? [leadId] : []);
    await api.dispose();
  }
});

test("a notification that did not go out is not an enquiry that did not arrive", async () => {
  /* THE DISTINCTION, END TO END. The alert is sent after the answer, from a
     row the function wrote with the lead (0101), precisely so a mail provider
     can never turn a saved enquiry into a failed one — and until 0096 its
     verdict was dropped, so a lead sat in the inbox with its response clock
     running and nothing anywhere saying nobody had been told. Locally and in
     CI there is no RESEND_API_KEY, so the worker claims nothing and spends
     no attempt: the enquiry is saved, the visitor has their 202, and the
     lead's `notification_jobs` row says — pending, zero attempts — that the
     desk has not been reached. No `enquiry_alert` event is written for that:
     an unconfigured deployment is a state the row shows, not an outcome. */
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const marker = `e2e-alertout-${randomBytes(3).toString("hex")}`;
  const api = await apiContext();
  let leadId: string | null = null;

  try {
    const res = await api.post("/api/public/enquiries", {
      data: {
        org: ORG_SLUG,
        name: `Web Buyer ${marker}`,
        email: `${marker}@example.invalid`,
        message: `Alert outcome probe ${marker}`,
      },
    });
    expect(res.status(), "the enquiry is accepted whatever the mailer does").toBe(202);

    const { data: leads } = await admin
      .from("leads")
      .select("id, status")
      .eq("org_id", orgId)
      .like("message", `%${marker}%`);
    expect(leads ?? [], "persistence succeeded — that is one fact").toHaveLength(1);
    leadId = leads![0]!.id as string;
    expect(leads![0]!.status).toBe("new");

    const { data: jobs, error: jobsErr } = await admin
      .from("notification_jobs")
      .select("*")
      .eq("lead_id", leadId);
    expect(jobsErr).toBeNull();
    expect(jobs ?? [], "and the notification is a SEPARATE fact, recorded with the lead").toHaveLength(1);
    const job = jobs![0]!;
    expect(job.kind).toBe("enquiry_desk_alert");
    expect(["pending", "sending", "accepted", "failed", "cancelled"]).toContain(job.state);
    expect(job.state, "no provider is configured here, and the record says the desk is not yet told").toBe(
      "pending",
    );
    expect(job.attempts, "an unconfigured worker spends no attempt").toBe(0);
    expect(job.provider_message_id).toBeNull();
    // the row carries ids and words only — nothing erasable, ever
    expect(JSON.stringify(job)).not.toContain(marker);
    // and nothing was attempted, so the timeline has no outcome to report
    const { data: alerts } = await admin
      .from("events")
      .select("id")
      .eq("entity_type", "lead")
      .eq("entity_id", leadId)
      .eq("event_type", "enquiry_alert");
    expect(alerts ?? [], "no attempt, no outcome event").toHaveLength(0);
  } finally {
    await removeLeads(admin, leadId ? [leadId] : []);
    await api.dispose();
  }
});

test("the sixth enquiry from one address is refused, and nothing is written for it", async () => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const marker = `e2e-rate-${randomBytes(3).toString("hex")}`;
  const api = await apiContext();
  const made: string[] = [];

  try {
    const send = (n: number) =>
      api.post("/api/public/enquiries", {
        data: {
          org: ORG_SLUG,
          name: `Web Buyer ${marker}-${n}`,
          email: `${marker}-${n}@example.invalid`,
          message: `Rate probe ${marker} number ${n}`,
        },
      });

    // RATE_LIMIT is 5 per visitor per quarter hour (lib/services/enquiry-budget.ts)
    for (let n = 1; n <= 5; n++) {
      expect((await send(n)).status(), `submission ${n} is within the budget`).toBe(202);
    }
    const sixth = await send(6);
    expect(sixth.status(), "the sixth is over it").toBe(429);
    expect(
      sixth.headers()["retry-after"],
      "and says when to come back, which the site passes through",
    ).toBeTruthy();
    expect((await sixth.json()).error).toMatch(/too many enquiries/i);

    const { data: leads } = await admin
      .from("leads")
      .select("id, message")
      .eq("org_id", orgId)
      .like("message", `%${marker}%`);
    for (const l of leads ?? []) made.push(l.id as string);
    expect(leads ?? [], "five saved, and the refused one wrote nothing").toHaveLength(5);
    expect(
      (leads ?? []).some((l) => String(l.message).includes("number 6")),
      "the refusal is checked BEFORE the write, so there is no sixth row",
    ).toBe(false);
  } finally {
    await removeLeads(admin, made);
    await api.dispose();
  }
});
