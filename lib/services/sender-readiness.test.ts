import { afterEach, describe, expect, it, vi } from "vitest";
import { senderReadiness } from "./enquiry-alert";
import { senderDomain, senderReadinessCopy, type SenderReadiness } from "./sender-readiness";

/**
 * Audit 2026-09-22 (late): what the activation preview may say about the
 * sender. Before this, the card said "armed" whenever RESEND_API_KEY and
 * ENQUIRY_ALERT_TO existed — including when the From fell back to Resend's
 * shared test sender, which delivers only to the account owner's own
 * address, and when a custom domain had never been verified. These pin the
 * four answers apart, pin that "verified" comes only from the provider's own
 * read-only answer, and pin that nothing here ever sends.
 */
const CONFIGURED = { RESEND_API_KEY: "re_test_key", ENQUIRY_ALERT_TO: "desk@example.com" } as unknown as NodeJS.ProcessEnv;
const CUSTOM = { ...CONFIGURED, ENQUIRY_ALERT_FROM: "GN Kalaitsidis <alerts@send.kalaitsidis.com>" } as unknown as NodeJS.ProcessEnv;

function domainsAnswer(data: unknown[], extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ object: "list", has_more: false, data, ...extra }), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("senderReadiness — the configuration the worker needs", () => {
  it("is not configured without the key or the desk address — the worker's own gate — and asks nobody", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const none = await senderReadiness({} as unknown as NodeJS.ProcessEnv);
    expect(none.state).toBe("not_configured");
    expect(none.state === "not_configured" && none.missing.join(" ")).toMatch(/RESEND_API_KEY/);
    expect(none.state === "not_configured" && none.missing.join(" ")).toMatch(/ENQUIRY_ALERT_TO/);
    const noTo = await senderReadiness({ RESEND_API_KEY: "re_x" } as unknown as NodeJS.ProcessEnv);
    expect(noTo).toEqual({ state: "not_configured", missing: ["ENQUIRY_ALERT_TO is not set"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is an unusable From when ENQUIRY_ALERT_FROM holds no address the provider accepts — the worker would still attempt, and be refused", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const unusable = [
      "",
      "   ",
      "GNK website",
      "GNK <>",
      "nobody@",
      "a@localhost",
      "GN Kalaitsidis alerts@send.kalaitsidis.com", // a display name without the brackets
      "GNK <alerts@send.kalaitsidis.com", // an unclosed bracket
      "alerts@send.kalaitsidis.com>",
    ];
    for (const from of unusable) {
      const r = await senderReadiness({ ...CONFIGURED, ENQUIRY_ALERT_FROM: from } as unknown as NodeJS.ProcessEnv);
      expect(r, JSON.stringify(from)).toEqual({ state: "invalid_from" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not configured — the worker's gate — even when the From is unusable too, and says both", async () => {
    const r = await senderReadiness({ ENQUIRY_ALERT_FROM: "GNK website" } as unknown as NodeJS.ProcessEnv);
    expect(r).toEqual({
      state: "not_configured",
      missing: ["RESEND_API_KEY is not set", "ENQUIRY_ALERT_TO is not set", "ENQUIRY_ALERT_FROM holds no usable e-mail address"],
    });
  });
});

describe("senderReadiness — Resend's shared test sender", () => {
  it("is the test sender when ENQUIRY_ALERT_FROM is absent (the default From) — without asking the provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(senderReadiness(CONFIGURED)).resolves.toEqual({ state: "test_sender", fromSet: false, domain: "resend.dev" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is the test sender for any resend.dev address set explicitly, however it is written — and says it was set", async () => {
    const cases: Array<[string, string]> = [
      ["onboarding@resend.dev", "resend.dev"],
      ["GNK website <onboarding@resend.dev>", "resend.dev"],
      ["X <x@Mail.Resend.Dev>", "mail.resend.dev"],
    ];
    for (const [from, domain] of cases) {
      await expect(senderReadiness({ ...CONFIGURED, ENQUIRY_ALERT_FROM: from } as unknown as NodeJS.ProcessEnv), from).resolves.toEqual({
        state: "test_sender",
        fromSet: true,
        domain,
      });
    }
    // a look-alike domain is NOT Resend's
    const lookalike = vi.spyOn(globalThis, "fetch").mockResolvedValue(domainsAnswer([]));
    const r = await senderReadiness({ ...CONFIGURED, ENQUIRY_ALERT_FROM: "x@notresend.dev" } as unknown as NodeJS.ProcessEnv);
    expect(r.state).not.toBe("test_sender");
    expect(lookalike).toHaveBeenCalledTimes(1);
  });
});

describe("senderReadiness — a custom sender, and what the provider says about its domain", () => {
  it("asks with ONE read-only GET of the domain list, with the deployment's key, and never sends", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(domainsAnswer([]));
    await senderReadiness(CUSTOM);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/api\.resend\.com\/domains(\?|$)/);
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.body, "a read carries no body").toBeUndefined();
    expect(new Headers(init!.headers as HeadersInit).get("authorization")).toBe("Bearer re_test_key");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/emails")), "nothing is sent").toBe(false);
  });

  it("is verified only when the provider lists THIS domain as verified with sending enabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      domainsAnswer([{ id: "d1", name: "Send.Kalaitsidis.com", status: "verified", capabilities: { sending: "enabled", receiving: "disabled" } }]),
    );
    await expect(senderReadiness(CUSTOM)).resolves.toEqual({ state: "domain_verified", domain: "send.kalaitsidis.com" });
  });

  it("does not borrow a verified PARENT or CHILD domain — Resend verifies each domain on its own", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      domainsAnswer([
        { id: "d1", name: "kalaitsidis.com", status: "verified" },
        { id: "d2", name: "x.send.kalaitsidis.com", status: "verified" },
      ]),
    );
    await expect(senderReadiness(CUSTOM)).resolves.toEqual({ state: "custom_not_verified", domain: "send.kalaitsidis.com", providerStatus: null });
  });

  it("is NOT verified when the provider reports the domain in any other state, and says which", async () => {
    for (const status of ["not_started", "pending", "partially_verified", "partially_failed", "failed", "temporary_failure"]) {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(domainsAnswer([{ id: "d1", name: "send.kalaitsidis.com", status }]));
      await expect(senderReadiness(CUSTOM), status).resolves.toEqual({
        state: "custom_not_verified",
        domain: "send.kalaitsidis.com",
        providerStatus: status,
      });
      vi.restoreAllMocks();
    }
  });

  it("is NOT verified when the domain is verified but sending is disabled on it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      domainsAnswer([{ id: "d1", name: "send.kalaitsidis.com", status: "verified", capabilities: { sending: "disabled", receiving: "enabled" } }]),
    );
    await expect(senderReadiness(CUSTOM)).resolves.toEqual({
      state: "custom_not_verified",
      domain: "send.kalaitsidis.com",
      providerStatus: "sending disabled",
    });
  });

  it("is UNKNOWN — not 'absent', not 'refused' — when the domain is listed without a status it can read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const row of [{ name: "send.kalaitsidis.com" }, { name: "send.kalaitsidis.com", status: 7 }, { name: "send.kalaitsidis.com", status: null }]) {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(domainsAnswer([row]));
      await expect(senderReadiness(CUSTOM), JSON.stringify(row)).resolves.toEqual({
        state: "custom_unverified",
        domain: "send.kalaitsidis.com",
        evidence: "lookup_failed",
      });
    }
  });

  it("is NOT verified when the domain is absent from a complete listing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(domainsAnswer([{ id: "d1", name: "other.example", status: "verified" }]));
    await expect(senderReadiness(CUSTOM)).resolves.toEqual({ state: "custom_not_verified", domain: "send.kalaitsidis.com", providerStatus: null });
  });

  it("is UNKNOWN — never green — when the key may only send and cannot read domains", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" }), { status: 401 }),
    );
    await expect(senderReadiness(CUSTOM)).resolves.toEqual({
      state: "custom_unverified",
      domain: "send.kalaitsidis.com",
      evidence: "key_cannot_read_domains",
    });
  });

  it("says the provider REJECTS the key when it answers so — a definite answer, not 'could not be asked'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [status, name] of [
      [403, "invalid_api_key"],
      [401, "missing_api_key"],
    ] as const) {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ statusCode: status, name, message: "x" }), { status }));
      await expect(senderReadiness(CUSTOM), name).resolves.toEqual({ state: "key_rejected" });
    }
  });

  it("is UNKNOWN when the provider cannot be asked — an error status, a network failure, a timeout, a shape it does not recognise", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const answers: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify({ name: "application_error" }), { status: 500 }),
      async () => new Response("not json", { status: 200 }),
      async () => new Response(JSON.stringify({ object: "list" }), { status: 200 }),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
    ];
    for (const answer of answers) {
      vi.spyOn(globalThis, "fetch").mockImplementation(answer);
      await expect(senderReadiness(CUSTOM)).resolves.toEqual({ state: "custom_unverified", domain: "send.kalaitsidis.com", evidence: "lookup_failed" });
      vi.restoreAllMocks();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    }
  });

  it("is UNKNOWN when the domain is not on a listing the provider says is incomplete", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(domainsAnswer([{ id: "d1", name: "other.example", status: "verified" }], { has_more: true }));
    await expect(senderReadiness(CUSTOM)).resolves.toEqual({
      state: "custom_unverified",
      domain: "send.kalaitsidis.com",
      evidence: "listing_incomplete",
    });
  });

  it("logs a status and an error name at most — never the key, never an address", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "restricted_api_key", message: "key re_test_key for desk@example.com" }), { status: 401 }),
    );
    await senderReadiness(CUSTOM);
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
    expect(logged).not.toContain("re_test_key");
    expect(logged).not.toContain("desk@example.com");
    expect(logged).not.toContain("alerts@send.kalaitsidis.com");
  });
});

describe("senderDomain", () => {
  it("reads the domain from a bare address or a display-name address, lower-cased", () => {
    expect(senderDomain("alerts@Send.Kalaitsidis.com")).toBe("send.kalaitsidis.com");
    expect(senderDomain("GN Kalaitsidis <alerts@send.kalaitsidis.com>")).toBe("send.kalaitsidis.com");
    expect(senderDomain(" GNK website <onboarding@resend.dev> ")).toBe("resend.dev");
  });

  it("finds no domain where there is no address in either form the provider accepts", () => {
    for (const from of [
      "",
      "GNK website",
      "GNK <>",
      "nobody@",
      "@example.com",
      "a@localhost",
      "GN Kalaitsidis alerts@send.kalaitsidis.com",
      "GNK <alerts@send.kalaitsidis.com",
      "alerts@send.kalaitsidis.com>",
      "a b@example.com",
      "GNK <a@example.com> trailing",
    ]) {
      expect(senderDomain(from), JSON.stringify(from)).toBeNull();
    }
  });
});

describe("what the card says about the sender", () => {
  const ALL: SenderReadiness[] = [
    { state: "not_configured", missing: ["RESEND_API_KEY is not set"] },
    { state: "invalid_from" },
    { state: "key_rejected" },
    { state: "test_sender", fromSet: false, domain: "resend.dev" },
    { state: "test_sender", fromSet: true, domain: "mail.resend.dev" },
    { state: "custom_unverified", domain: "send.kalaitsidis.com", evidence: "key_cannot_read_domains" },
    { state: "custom_unverified", domain: "send.kalaitsidis.com", evidence: "lookup_failed" },
    { state: "custom_unverified", domain: "send.kalaitsidis.com", evidence: "listing_incomplete" },
    { state: "custom_not_verified", domain: "send.kalaitsidis.com", providerStatus: "pending" },
    { state: "custom_not_verified", domain: "send.kalaitsidis.com", providerStatus: "temporary_failure" },
    { state: "custom_not_verified", domain: "send.kalaitsidis.com", providerStatus: null },
    { state: "domain_verified", domain: "send.kalaitsidis.com" },
  ];

  it("has words for every answer, and only a verified domain is not a warning", () => {
    for (const r of ALL) {
      const copy = senderReadinessCopy(r);
      expect(copy.text.length, r.state).toBeGreaterThan(20);
      expect(copy.tone, r.state).not.toBe(r.state === "domain_verified" ? "danger" : "neutral");
    }
    expect(senderReadinessCopy({ state: "domain_verified", domain: "send.kalaitsidis.com" }).tone).toBe("neutral");
    expect(senderReadinessCopy({ state: "custom_unverified", domain: "d.example", evidence: "lookup_failed" }).tone).toBe("warning");
  });

  it("says refused only where the provider's answer establishes it: not started, pending, failed, sending disabled, or not in the account", () => {
    for (const status of ["not_started", "pending", "failed", "sending disabled", null]) {
      const copy = senderReadinessCopy({ state: "custom_not_verified", domain: "send.kalaitsidis.com", providerStatus: status });
      expect(copy.text, String(status)).toMatch(/refuses/i);
      expect(copy.tone).toBe("danger");
    }
    for (const status of ["partially_verified", "partially_failed", "temporary_failure"]) {
      const copy = senderReadinessCopy({ state: "custom_not_verified", domain: "send.kalaitsidis.com", providerStatus: status });
      expect(copy.text, status).toContain(status);
      expect(copy.text, status).toMatch(/not "verified"/);
    }
  });

  it("names the From that was set, and never calls a set variable unset", () => {
    expect(senderReadinessCopy({ state: "test_sender", fromSet: false, domain: "resend.dev" }).text).toMatch(/ENQUIRY_ALERT_FROM is not set/);
    const set = senderReadinessCopy({ state: "test_sender", fromSet: true, domain: "mail.resend.dev" }).text;
    expect(set).not.toMatch(/not set/);
    expect(set).toContain("mail.resend.dev");
  });

  it("says an unusable From and a rejected key make every attempt fail — not that the jobs would wait", () => {
    for (const r of [{ state: "invalid_from" }, { state: "key_rejected" }] as SenderReadiness[]) {
      const text = senderReadinessCopy(r).text;
      expect(text, r.state).toMatch(/refuse/i);
      expect(text, r.state).not.toMatch(/would wait/i);
    }
    expect(senderReadinessCopy({ state: "not_configured", missing: ["RESEND_API_KEY is not set"] }).text).toMatch(/would wait/i);
  });

  it("never calls anything delivered — verification is not delivery", () => {
    for (const r of ALL) expect(senderReadinessCopy(r).text, r.state).not.toMatch(/\bwill (be )?deliver|\bis delivered|\breaches (the|their) inbox/i);
    expect(senderReadinessCopy({ state: "domain_verified", domain: "send.kalaitsidis.com" }).text).toMatch(/not delivery/i);
  });

  it("says the test sender reaches only the account's own address, and what to set", () => {
    const text = senderReadinessCopy({ state: "test_sender", fromSet: false, domain: "resend.dev" }).text;
    expect(text).toMatch(/onboarding@resend\.dev/);
    expect(text).toMatch(/own address|owns the Resend account/i);
    expect(text).toMatch(/ENQUIRY_ALERT_FROM/);
  });

  it("says unknown when it is unknown, and names what is missing when something is", () => {
    expect(senderReadinessCopy({ state: "custom_unverified", domain: "send.kalaitsidis.com", evidence: "key_cannot_read_domains" }).text).toMatch(/unknown/i);
    expect(senderReadinessCopy({ state: "not_configured", missing: ["ENQUIRY_ALERT_TO is not set"] }).text).toContain("ENQUIRY_ALERT_TO is not set");
    expect(senderReadinessCopy({ state: "custom_not_verified", domain: "send.kalaitsidis.com", providerStatus: "pending" }).text).toContain("pending");
  });
});
