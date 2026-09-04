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

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

const ORG_SLUG = "gnk";

test("a website enquiry becomes a lead the desk can work", async () => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const marker = `e2e-enq-${randomBytes(3).toString("hex")}`;
  const api = await pwRequest.newContext({ baseURL: baseUrl() });

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
  const api = await pwRequest.newContext({ baseURL: baseUrl() });
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
  const api = await pwRequest.newContext({ baseURL: baseUrl() });

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

test("CORS is open for a site on another origin, POST only", async () => {
  const api = await pwRequest.newContext({ baseURL: baseUrl() });
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
