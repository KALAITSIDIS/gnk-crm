import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadinessOverview } from "@/components/features/settings/readiness-overview";
import {
  buildReadinessRows,
  loadReadinessFacts,
  readEnvFlags,
  READINESS_STATES,
  STATE_LABEL,
  technicalFlags,
  type ReadinessFacts,
  type ReadinessMember,
  type ReadinessRow,
} from "./activation-readiness";
import { BRANDING_USE } from "./branding";
import { LEAD_ESCALATION_DEFAULTS, type LeadEscalationConfig } from "./lead-escalation";
import { senderReadinessCopy, type SenderReadiness } from "./sender-readiness";

/**
 * The Settings overview (A07): one read-only list of what is on, what waits on
 * a step outside the CRM and what is not built. These pin, row by row, that
 * each answer comes from the existing rule (not a copy of it), that a failed
 * read says "Could not check" and never "Off", and that no environment VALUE
 * — a key, an address — can reach a row or the rendered page.
 */

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

const ADMIN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const LISTING_MANAGER = "33333333-3333-4333-8333-333333333333";
const GONE = "44444444-4444-4444-8444-444444444444";
const NO_ADDRESS = "55555555-5555-4555-8555-555555555555";

const MEMBERS: ReadinessMember[] = [
  { id: ADMIN, role: "admin", isActive: true, hasAddress: true },
  { id: AGENT, role: "agent", isActive: true, hasAddress: true },
  { id: LISTING_MANAGER, role: "listing_manager", isActive: true, hasAddress: true },
  { id: GONE, role: "agent", isActive: false, hasAddress: true },
  { id: NO_ADDRESS, role: "agent", isActive: true, hasAddress: false },
];

const VERIFIED: SenderReadiness = { state: "domain_verified", domain: "send.example.test" };
const TEST_SENDER: SenderReadiness = { state: "test_sender", fromSet: false, domain: "resend.dev" };
const UNKNOWN_SENDER: SenderReadiness = { state: "custom_unverified", domain: "send.example.test", evidence: "lookup_failed" };
const NOT_VERIFIED: SenderReadiness = { state: "custom_not_verified", domain: "send.example.test", providerStatus: "pending" };
const NOT_CONFIGURED: SenderReadiness = { state: "not_configured", missing: ["RESEND_API_KEY is not set"] };

const policy = (over: Partial<LeadEscalationConfig> = {}): LeadEscalationConfig => ({ ...LEAD_ESCALATION_DEFAULTS, ...over });

function facts(over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    env: readEnvFlags(env({})),
    routing: { ok: true, value: { mode: "off", agents: [] } },
    escalation: { ok: true, value: policy() },
    members: { ok: true, value: MEMBERS },
    branding: { ok: true, value: { logo: false, watermark: false } },
    ...over,
  };
}

const row = (rows: ReadinessRow[], id: string): ReadinessRow => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};
const rowOf = (f: ReadinessFacts, id: string, sender: SenderReadiness | null = VERIFIED) => row(buildReadinessRows(f, sender), id);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Lead routing — the SQL's rule, stated", () => {
  it("off: enquiries wait unassigned; the next step is the admin's, on Lead routing", () => {
    const r = rowOf(facts(), "lead-routing");
    expect(r.state).toBe("off");
    expect(r.summary).toMatch(/arrive unassigned/);
    // raise_lead_sla_tasks: the lead's agent, else the oldest active admin
    expect(r.summary).toMatch(/follow-up task goes to whoever took it — or, if nobody did, to the oldest active admin/);
    expect(r.nextStep?.who).toBe("admin");
    expect(r.link?.href).toBe("/settings/lead-routing");
  });

  it("round-robin counts the ACTIVE members it names, any role — as submit_public_enquiry does", () => {
    const r = rowOf(
      facts({ routing: { ok: true, value: { mode: "round_robin", agents: [ADMIN, LISTING_MANAGER, GONE, "not-a-member"] } } }),
      "lead-routing",
    );
    expect(r.state).toBe("on");
    expect(r.summary).toMatch(/^Round-robin over 2 people/);
    expect(r.nextStep).toBeNull();
  });

  it("round-robin over nobody usable needs attention — it behaves as off", () => {
    const r = rowOf(facts({ routing: { ok: true, value: { mode: "round_robin", agents: [GONE] } } }), "lead-routing");
    expect(r.state).toBe("attention");
    expect(r.summary).toMatch(/as if routing were off/);
  });

  it("an unreadable rule, or unreadable members under round-robin, is 'Could not check' — never 'Off'", () => {
    expect(rowOf(facts({ routing: { ok: false } }), "lead-routing").state).toBe("unknown");
    expect(
      rowOf(facts({ routing: { ok: true, value: { mode: "round_robin", agents: [ADMIN] } }, members: { ok: false } }), "lead-routing").state,
    ).toBe("unknown");
    // off needs nobody, so unreadable members do not hide what off means
    expect(rowOf(facts({ members: { ok: false } }), "lead-routing").state).toBe("off");
  });
});

describe("Lead escalation — the policy and the sender together", () => {
  it("off with an unverified sender: off, waiting for a verified sending domain, next step the operator's", () => {
    const r = rowOf(facts(), "lead-escalation", TEST_SENDER);
    expect(r.state).toBe("off");
    expect(r.summary).toMatch(/^Off\./);
    expect(r.summary).toMatch(/waits for a verified sending domain/);
    expect(r.nextStep?.who).toBe("operator");
  });

  it("off with a verified sender: the decision is the admin's — preview, then Save", () => {
    const r = rowOf(facts(), "lead-escalation", VERIFIED);
    expect(r.state).toBe("off");
    expect(r.summary).not.toMatch(/waits for/);
    expect(r.nextStep).toEqual({ who: "admin", text: expect.stringMatching(/preview, then Save/) });
  });

  it("off with no e-mail set up at all says so, not 'unverified'", () => {
    const r = rowOf(facts(), "lead-escalation", NOT_CONFIGURED);
    expect(r.state).toBe("off");
    expect(r.summary).toMatch(/e-mail to be set up/);
  });

  it("on with an unverified sender needs attention", () => {
    const r = rowOf(facts({ escalation: { ok: true, value: policy({ enabled: true, recipients: [ADMIN, AGENT] }) } }), "lead-escalation", TEST_SENDER);
    expect(r.state).toBe("attention");
    expect(r.summary).toMatch(/not verified/);
    expect(r.nextStep?.who).toBe("operator");
  });

  it("on with a verified sender is on, counting recipients by escalationRecipients' rule", () => {
    const r = rowOf(
      facts({
        escalation: {
          ok: true,
          value: policy({ enabled: true, recipients: [ADMIN, AGENT, LISTING_MANAGER, GONE, NO_ADDRESS], working_hours: null }),
        },
      }),
      "lead-escalation",
      VERIFIED,
    );
    expect(r.state).toBe("on");
    // the listing manager, the inactive agent and the one with no address are not eligible
    expect(r.summary).toMatch(/2 recipients e-mailed/);
    expect(r.summary).toMatch(/15 minutes of clock time/);
  });

  it("on with nobody eligible needs attention whatever the sender", () => {
    const r = rowOf(
      facts({ escalation: { ok: true, value: policy({ enabled: true, recipients: [LISTING_MANAGER, GONE] }) } }),
      "lead-escalation",
      VERIFIED,
    );
    expect(r.state).toBe("attention");
    expect(r.summary).toMatch(/cancelled with nobody to tell/);
  });

  it("an unreadable policy is 'Could not check', and an unknown sender under an enabled policy is too", () => {
    expect(rowOf(facts({ escalation: { ok: false } }), "lead-escalation").state).toBe("unknown");
    expect(
      rowOf(facts({ escalation: { ok: true, value: policy({ enabled: true, recipients: [ADMIN] }) } }), "lead-escalation", UNKNOWN_SENDER).state,
    ).toBe("unknown");
  });
});

describe("the e-mail rows — desk alert, sending domain, visitor acknowledgement", () => {
  const armed = (extra: Record<string, string> = {}) =>
    facts({ env: readEnvFlags(env({ RESEND_API_KEY: "re_k", ENQUIRY_ALERT_TO: "a@example.test", ...extra })) });

  it("desk alert unarmed needs setup outside the CRM, naming the missing variables", () => {
    const r = rowOf(facts(), "desk-alert", NOT_CONFIGURED);
    expect(r.state).toBe("needs_setup");
    expect(r.summary).toMatch(/RESEND_API_KEY and ENQUIRY_ALERT_TO not set/);
    expect(r.nextStep?.who).toBe("operator");
  });

  it("desk alert armed: a count of addresses, never the addresses", () => {
    const r = rowOf(armed(), "desk-alert", VERIFIED);
    expect(r.state).toBe("on");
    expect(r.summary).toMatch(/1 desk address, from send\.example\.test/);
    expect(JSON.stringify(r)).not.toContain("a@example.test");
  });

  it("desk alert from the test sender: on for one address, attention when the one message names several", () => {
    expect(rowOf(armed(), "desk-alert", TEST_SENDER).state).toBe("on");
    expect(rowOf(armed(), "desk-alert", TEST_SENDER).summary).toMatch(/only if that address owns the Resend account/);
    const two = rowOf(armed({ ENQUIRY_ALERT_TO: "a@example.test, b@example.test" }), "desk-alert", TEST_SENDER);
    expect(two.state).toBe("attention");
    expect(two.summary).toMatch(/2 desk addresses in one message/);
  });

  it("desk alert armed by a list that names nobody is not 'on'", () => {
    expect(rowOf(armed({ ENQUIRY_ALERT_TO: " , " }), "desk-alert", VERIFIED).state).toBe("attention");
  });

  it("sending domain: each provider answer gets its pill, and its sentence is senderReadinessCopy's", () => {
    const cases: Array<[SenderReadiness, string, string]> = [
      [VERIFIED, "on", "Verified"],
      [TEST_SENDER, "needs_setup", "Test sender only"],
      [NOT_CONFIGURED, "needs_setup", "Not configured"],
      [UNKNOWN_SENDER, "unknown", "Could not check"],
      [NOT_VERIFIED, "attention", "Refused"],
      [{ state: "invalid_from" }, "attention", "Refused"],
      [{ state: "key_rejected" }, "attention", "Refused"],
    ];
    for (const [sender, state, label] of cases) {
      const r = rowOf(facts(), "sending-domain", sender);
      expect(r.state, sender.state).toBe(state);
      expect(r.label, sender.state).toBe(label);
      expect(r.summary, sender.state).toBe(senderReadinessCopy(sender).text);
      expect(r.nextStep === null, sender.state).toBe(sender.state === "domain_verified");
    }
  });

  it("visitor acknowledgement: off without a real From; on only once the provider verified the domain", () => {
    expect(rowOf(facts(), "visitor-ack", NOT_CONFIGURED).state).toBe("needs_setup");
    expect(rowOf(armed({ ENQUIRY_ALERT_FROM: "GNK <onboarding@resend.dev>" }), "visitor-ack", TEST_SENDER).state).toBe("needs_setup");
    const custom = armed({ ENQUIRY_ALERT_FROM: "GNK <hello@send.example.test>" });
    expect(rowOf(custom, "visitor-ack", VERIFIED).state).toBe("on");
    expect(rowOf(custom, "visitor-ack", NOT_VERIFIED).state).toBe("attention");
    expect(rowOf(custom, "visitor-ack", UNKNOWN_SENDER).state).toBe("unknown");
  });

  it("while the provider is still being asked, the rows that depend on it say Checking — never a guess", () => {
    const f = facts({ env: readEnvFlags(env({ RESEND_API_KEY: "re_k", ENQUIRY_ALERT_TO: "a@x.test", ENQUIRY_ALERT_FROM: "h@send.example.test" })) });
    const rows = buildReadinessRows(f, null);
    expect(row(rows, "sending-domain").state).toBe("checking");
    expect(row(rows, "desk-alert").state).toBe("checking");
    expect(row(rows, "visitor-ack").state).toBe("checking");
    // an off policy is off whatever the sender
    expect(row(rows, "lead-escalation").state).toBe("off");
    // and the rows that never ask the provider are unaffected
    expect(row(rows, "lead-routing").state).toBe("off");
  });
});

describe("branding, website refresh, portals", () => {
  it("logo and watermark: present or absent, in honest words — the logo prints nowhere yet", () => {
    const none = buildReadinessRows(facts(), VERIFIED);
    expect(row(none, "logo")).toMatchObject({ state: "off", label: "Not uploaded" });
    expect(row(none, "logo").summary).toMatch(/No document or report prints one yet/);
    expect(row(none, "watermark")).toMatchObject({ state: "off", label: "Not uploaded" });
    const both = buildReadinessRows(facts({ branding: { ok: true, value: { logo: true, watermark: true } } }), VERIFIED);
    expect(row(both, "logo")).toMatchObject({ state: "on", label: "Uploaded", summary: BRANDING_USE.logo });
    expect(row(both, "watermark")).toMatchObject({ state: "on", label: "Uploaded", summary: BRANDING_USE.watermark });
    expect(row(both, "watermark").summary).toMatch(/not re-processed/);
  });

  it("an unreadable branding folder is 'Could not check' for both — never 'Not uploaded'", () => {
    const rows = buildReadinessRows(facts({ branding: { ok: false } }), VERIFIED);
    for (const id of ["logo", "watermark"]) {
      expect(row(rows, id).state).toBe("unknown");
      expect(row(rows, id).label).toBeUndefined();
    }
  });

  it("website refresh: on with both variables, otherwise needs setup naming what is missing", () => {
    expect(rowOf(facts({ env: readEnvFlags(env({ SITE_REVALIDATE_URL: "https://x.test/r", SITE_REVALIDATE_KEY: "k" })) }), "site-refresh").state).toBe("on");
    const half = rowOf(facts({ env: readEnvFlags(env({ SITE_REVALIDATE_URL: "https://x.test/r" })) }), "site-refresh");
    expect(half.state).toBe("needs_setup");
    expect(half.summary).toMatch(/SITE_REVALIDATE_KEY not set/);
    expect(half.summary).toMatch(/within an hour/);
  });

  it("portals: the four not built, with the repo's reasons, and a link to the Portals page — no portal state claimed", () => {
    const r = rowOf(facts(), "portals");
    expect(r.state).toBe("not_built");
    expect(r.summary).toMatch(/RERA\.cy and Thribee are scheduled for portal milestone 2/);
    expect(r.summary).toMatch(/Bazaraki Pro and Prian\.ru need the portal's XML format/);
    expect(r.link?.href).toBe("/settings/portals");
    // it never counts or names a portal as enabled: that is the Portals page's to say
    expect(r.summary).not.toMatch(/\benabled\b|\d+ of \d+/i);
  });
});

describe("every row", () => {
  it("has a state from the vocabulary, a pill word, and no failed read rendered as 'Off'", () => {
    const allFailed = facts({ routing: { ok: false }, escalation: { ok: false }, members: { ok: false }, branding: { ok: false } });
    for (const sender of [VERIFIED, TEST_SENDER, NOT_CONFIGURED, UNKNOWN_SENDER, null]) {
      for (const f of [facts(), allFailed]) {
        for (const r of buildReadinessRows(f, sender)) {
          expect(READINESS_STATES).toContain(r.state);
          expect((r.label ?? STATE_LABEL[r.state]).length).toBeGreaterThan(0);
        }
      }
      const failedRows = buildReadinessRows(allFailed, sender);
      for (const id of ["lead-routing", "lead-escalation", "logo", "watermark"]) {
        expect(row(failedRows, id).state, id).toBe("unknown");
      }
    }
  });
});

describe("no environment VALUE reaches a row or the page", () => {
  const KEY = "re_SENTINEL_KEY_9f8e7d";
  const DESK = "sentinel-desk@x.test";
  const SECRET_VALUES = [KEY, DESK, "SENTINEL_CRON", "SENTINEL_SALT", "SENTINEL_FORWARD", "SENTINEL_REVALIDATE", "https://sentinel-dsn.example/1"];
  const SENTINEL_ENV = env({
    RESEND_API_KEY: KEY,
    ENQUIRY_ALERT_TO: `${DESK}, second-${DESK}`,
    ENQUIRY_ALERT_FROM: "GNK <hello@send.sentinel-domain.test>",
    CRON_SECRET: "SENTINEL_CRON",
    IP_HASH_SALT: "SENTINEL_SALT",
    ENQUIRY_FORWARD_KEY: "SENTINEL_FORWARD",
    SITE_REVALIDATE_URL: "https://site.test/api/revalidate",
    SITE_REVALIDATE_KEY: "SENTINEL_REVALIDATE",
    SENTRY_DSN: "https://sentinel-dsn.example/1",
    NEXT_PUBLIC_SENTRY_DSN: "https://sentinel-dsn.example/1",
  });

  it("readEnvFlags returns booleans, counts and the From's public domain only", () => {
    const flags = readEnvFlags(SENTINEL_ENV);
    const json = JSON.stringify(flags);
    for (const v of SECRET_VALUES) expect(json).not.toContain(v);
    expect(json).not.toContain("site.test/api/revalidate");
    expect(flags.alertToCount).toBe(2);
    expect(flags.senderDomain).toBe("send.sentinel-domain.test");
    for (const [k, v] of Object.entries(flags)) {
      if (k === "senderDomain") continue;
      expect(["boolean", "number"], k).toContain(typeof v);
    }
  });

  it("every row, every technical flag, and the rendered overview hold none of the values", () => {
    const f = facts({ env: readEnvFlags(SENTINEL_ENV) });
    for (const sender of [VERIFIED, NOT_VERIFIED, TEST_SENDER, { state: "key_rejected" } as SenderReadiness, null]) {
      const json = JSON.stringify([buildReadinessRows(f, sender), technicalFlags(f.env)]);
      const html = renderToStaticMarkup(createElement(ReadinessOverview, { facts: f, sender }));
      for (const v of SECRET_VALUES) {
        expect(json, v).not.toContain(v);
        expect(html, v).not.toContain(v);
      }
      expect(html).not.toMatch(/\bre_[A-Za-z0-9]{6,}/);
      expect(html).toContain("ENQUIRY_ALERT_TO");
      expect(html).toContain("2 addresses");
    }
  });

  it("the overview renders no form, no button and no input — nothing on it can switch anything on", () => {
    const html = renderToStaticMarkup(createElement(ReadinessOverview, { facts: facts({ env: readEnvFlags(SENTINEL_ENV) }), sender: VERIFIED }));
    expect(html).not.toMatch(/<form|<button|<input|<select|<textarea/);
    expect(html).toContain('data-testid="readiness-lead-routing"');
    expect(html).toContain("<details");
  });
});

/* ------------------------------------------------------------------------- */
/* the loader                                                                */
/* ------------------------------------------------------------------------- */

type Page = { data: unknown; error: { message: string } | null };

/** A client whose two table reads answer as scripted, recording what was asked. */
function sessionClient(pages: { cyprus_config: Page | Error; profiles: Page | Error }) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = (table: "cyprus_config" | "profiles") => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "in", "eq"]) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return chain;
      };
    }
    chain.then = (resolve: (v: Page) => void, reject: (e: unknown) => void) => {
      const answer = pages[table];
      return answer instanceof Error ? reject(answer) : resolve(answer);
    };
    return chain;
  };
  return { client: { from } as never, calls };
}

function adminClient(listing: Page | Error) {
  return {
    storage: {
      from: () => ({
        list: async () => {
          if (listing instanceof Error) throw listing;
          return listing;
        },
      }),
    },
  } as never;
}

describe("loadReadinessFacts — every read checked, none thrown", () => {
  const CONFIG_OK: Page = {
    data: [
      { key: "lead_routing", value: { mode: "round_robin", agents: [ADMIN] } },
      { key: "lead_escalation", value: { enabled: true, recipients: [ADMIN] } },
    ],
    error: null,
  };
  const PROFILES_OK: Page = {
    data: [
      { id: ADMIN, role: "admin", is_active: true, email: "admin-sentinel@x.test" },
      { id: AGENT, role: "agent", is_active: false, email: " " },
    ],
    error: null,
  };
  const LISTING_OK: Page = { data: [{ name: "watermark.png", updated_at: "2026-10-01T00:00:00Z" }], error: null };

  it("maps the rows through the readers, scopes profiles to the org, and keeps no address", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = sessionClient({ cyprus_config: CONFIG_OK, profiles: PROFILES_OK });
    const f = await loadReadinessFacts(s.client, () => adminClient(LISTING_OK), "org-1", env({}));
    expect(f.routing).toEqual({ ok: true, value: { mode: "round_robin", agents: [ADMIN] } });
    expect(f.escalation.ok && f.escalation.value.enabled).toBe(true);
    expect(f.escalation.ok && f.escalation.value.after_minutes).toBe(15); // readLeadEscalation's default
    expect(f.members).toEqual({
      ok: true,
      value: [
        { id: ADMIN, role: "admin", isActive: true, hasAddress: true },
        { id: AGENT, role: "agent", isActive: false, hasAddress: false },
      ],
    });
    expect(f.branding).toEqual({ ok: true, value: { logo: false, watermark: true } });
    expect(JSON.stringify(f)).not.toContain("admin-sentinel@x.test");
    expect(s.calls).toContainEqual({ table: "profiles", method: "eq", args: ["org_id", "org-1"] });
    expect(s.calls).toContainEqual({ table: "cyprus_config", method: "in", args: ["key", ["lead_routing", "lead_escalation"]] });
  });

  it("a missing config row is the seeded default (off), not a failure — as the SQL readers treat it", async () => {
    const s = sessionClient({ cyprus_config: { data: [], error: null }, profiles: PROFILES_OK });
    const f = await loadReadinessFacts(s.client, () => adminClient(LISTING_OK), "org-1", env({}));
    expect(f.routing).toEqual({ ok: true, value: { mode: "off", agents: [] } });
    expect(f.escalation.ok && f.escalation.value.enabled).toBe(false);
  });

  it("an error, a hollow answer, or a rejected read is { ok: false } — and the page still renders", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [config, profiles, listing] of [
      [{ data: null, error: { message: "boom" } }, { data: null, error: { message: "boom" } }, { data: null, error: { message: "boom" } }],
      [{ data: null, error: null }, { data: null, error: null }, { data: null, error: null }],
      [new Error("network"), new Error("network"), new Error("network")],
    ] as Array<[Page | Error, Page | Error, Page | Error]>) {
      const s = sessionClient({ cyprus_config: config, profiles });
      const f = await loadReadinessFacts(s.client, () => adminClient(listing), "org-1", env({}));
      expect(f.routing).toEqual({ ok: false });
      expect(f.escalation).toEqual({ ok: false });
      expect(f.members).toEqual({ ok: false });
      expect(f.branding).toEqual({ ok: false });
      const html = renderToStaticMarkup(createElement(ReadinessOverview, { facts: f, sender: VERIFIED }));
      expect(html).toContain("Could not check");
    }
    expect(warn).toHaveBeenCalled();
  });

  it("a service client that cannot be built costs the branding rows only — the page still renders", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = sessionClient({ cyprus_config: CONFIG_OK, profiles: PROFILES_OK });
    const f = await loadReadinessFacts(
      s.client,
      () => {
        throw new Error("supabaseKey is required.");
      },
      "org-1",
      env({}),
    );
    expect(f.branding).toEqual({ ok: false });
    expect(f.routing.ok).toBe(true);
    expect(f.members.ok).toBe(true);
  });
});
